import { EventEmitter } from 'events';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbService, JobRecord, ChannelRecord } from '../database/db.ts';
import { bootstrapRuntimeEnvironment } from '../config/bootstrap.ts';
import {
  downloadEngine,
  probeVideoUrl,
  isDirectVideoUrl,
  fetchDirectLinksFromPost,
  resolveBestDirectStreamFromPost,
} from '../downloader/engine.ts';
import {
  extractVideoMetadata,
  generateThumbnail,
  downloadAndPreparePostThumbnail,
  formatMetadataCaption,
  formatBytes,
} from '../media/processor.ts';
import { storageManager } from '../storage/manager.ts';
import { telegramBridge } from '../telegram/bridge.ts';
import { logger } from '../logs/logger.ts';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildProgressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export interface CreateJobInput {
  url: string;
  title?: string;
  extractor?: string;
  quality?: string;
  formatId?: string;
  destinationId?: string;
  destinationChatId?: string;
  customCaption?: string;
  useAutoCaption?: boolean;
  customThumbnailPath?: string;
  thumbnailTimestamp?: string;
  thumbnailUrl?: string;
  sourceOrigin?: 'web' | 'telegram';
  telegramChatId?: string | null;
  telegramMessageId?: number | null;
  deferTelegramSync?: boolean;
}

export class JobQueueManager extends EventEmitter {
  private activeDownloadJobId: string | null = null;
  private activeUploadJobId: string | null = null;
  private uploadReadyQueue: string[] = [];
  private cancelledJobIds: Set<string> = new Set();

  constructor() {
    super();

    // Listen to Wzgram live upload progress events
    telegramBridge.on('upload_progress', (payload) => {
      const { jobId, percent, uploadedBytes, totalBytes, speed, eta, stageMessage, resetProgress } = payload;
      if (!jobId || this.cancelledJobIds.has(jobId)) return;
      const existing = dbService.getJobById(jobId);
      if (!existing || existing.status !== 'uploading') return;

      const rawUploaded = Math.max(0, Number(uploadedBytes || 0));
      const rawPct = Math.max(0, Math.min(100, Number(percent || 0)));
      const safeUploaded = resetProgress ? rawUploaded : Math.max(existing.uploadedBytes || 0, rawUploaded);
      const safeTotal = Number(totalBytes || existing.totalBytes || 0);
      const safePct = resetProgress ? rawPct : Math.max(existing.uploadProgress || 0, rawPct);
      const sizeInfo =
        safeTotal > 0
          ? `${formatBytes(safeUploaded)} / ${formatBytes(safeTotal)}`
          : formatBytes(safeUploaded);
      const updated = dbService.updateJob(jobId, {
        status: 'uploading',
        uploadProgress: safePct,
        uploadedBytes: safeUploaded,
        totalBytes: safeTotal || undefined,
        uploadSpeed: speed || '0 B/s',
        uploadEta: eta || '--:--',
        stageMessage: stageMessage || `Uploading via MTProto (${safePct.toFixed(1)}% · ${sizeInfo})`,
      });
      if (updated) {
        this.emit('job:updated', updated);
        if (updated.sourceOrigin === 'telegram') {
          this.syncTelegramPipelineProgress(updated, false);
        }
      }
    });

    // Listen to incoming Telegram bot URL submissions
    telegramBridge.on('telegram_job_request', async (payload) => {
      try {
        await this.enqueueJob({
          url: payload.url,
          title: payload.title,
          extractor: payload.extractor,
          thumbnailUrl: payload.thumbnailUrl,
          quality: payload.quality || 'best',
          formatId: payload.formatId || payload.quality || 'best',
          destinationChatId: payload.destinationChatId,
          sourceOrigin: 'telegram',
          telegramChatId: payload.telegramChatId,
          telegramMessageId: payload.telegramMessageId,
        });
      } catch (err: any) {
        logger.error('TELEGRAM', 'Failed to enqueue Telegram job request', err?.message);
      }
    });

    // Listen to incoming Telegram /fetch command requests
    telegramBridge.on('telegram_fetch_request', async (payload) => {
      const { reqKey, url, telegramChatId, telegramMessageId } = payload;
      try {
        const result = await fetchDirectLinksFromPost(url);
        telegramBridge.sendFetchLinksResult({
          reqKey,
          telegramChatId,
          telegramMessageId,
          url,
          ok: true,
          result,
        });
      } catch (err: any) {
        logger.warn('TELEGRAM', `Telegram /fetch failed for ${url}`, err?.message);
        telegramBridge.sendFetchLinksResult({
          reqKey,
          telegramChatId,
          telegramMessageId,
          url,
          ok: false,
          error: err?.message || 'Could not extract direct video links or posts from this URL',
        });
      }
    });

    // Listen to incoming Telegram batch post download & upload requests
    telegramBridge.on('telegram_batch_job_request', async (payload) => {
      const {
        posts,
        quality,
        destinationChatId,
        telegramChatId,
        telegramMessageId,
      } = payload;
      if (!Array.isArray(posts) || posts.length === 0) return;

      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        if (!p || !p.postUrl) continue;
        try {
          await this.enqueueJob({
            url: p.postUrl,
            title: p.title || `Batch Post #${i + 1}`,
            extractor: 'Post Crawler',
            thumbnailUrl: p.thumbnail || '',
            quality: quality || 'best',
            formatId: quality || 'best',
            destinationChatId,
            sourceOrigin: 'telegram',
            telegramChatId,
            telegramMessageId: telegramMessageId || null,
            deferTelegramSync: i < posts.length - 1,
          });
        } catch (err: any) {
          logger.error('TELEGRAM', `Failed to enqueue batch post ${p.postUrl}`, err?.message);
        }
      }
    });

    // Listen to Telegram inline button Cancel
    telegramBridge.on('telegram_cancel_job', (jobId: string) => {
      this.cancelJob(jobId);
    });

    // Listen to Telegram inline button Retry
    telegramBridge.on('telegram_retry_job', (jobId: string) => {
      this.retryJob(jobId);
    });
  }

  public recoverInterruptedJobs(): void {
    const jobs = dbService.getAllJobs();
    for (const j of jobs) {
      if (['extracting', 'downloading', 'processing_media', 'ready_for_upload', 'uploading'].includes(j.status)) {
        dbService.updateJob(j.id, {
          status: 'queued',
          stageMessage: 'Recovered after server restart — queued',
        });
      }
    }
    this.schedulePipeline();
  }

  public async enqueueJob(input: CreateJobInput): Promise<JobRecord> {
    const settings = dbService.getSettings();
    const channels = dbService.getChannels();
    let selectedChannel: ChannelRecord | undefined;

    if (input.destinationId) {
      selectedChannel = channels.find((c) => c.id === input.destinationId);
    } else if (input.destinationChatId) {
      selectedChannel = channels.find((c) => c.chatId === input.destinationChatId);
    } else {
      selectedChannel = channels.find((c) => c.isDefault) || channels[0];
    }

    const explicitChatId = input.destinationChatId?.trim();
    const destinationId = selectedChannel
      ? selectedChannel.id
      : explicitChatId
      ? `chat:${explicitChatId}`
      : 'custom';

    const destinationName = selectedChannel
      ? `${selectedChannel.name} (${selectedChannel.chatId})`
      : explicitChatId
      ? explicitChatId === input.telegramChatId
        ? `Telegram Private Chat (${explicitChatId})`
        : `Target Chat (${explicitChatId})`
      : settings.targetChannel || 'Telegram Chat';

    const now = new Date().toISOString();
    const job: JobRecord = {
      id: uuidv4().slice(0, 8),
      url: input.url.trim(),
      title: input.title || 'Inspecting Video Stream...',
      extractor: input.extractor || 'auto',
      quality: input.quality || settings.defaultQuality || 'best',
      formatId: input.formatId || input.quality || 'best',
      destinationId,
      destinationName,
      customCaption: input.customCaption || '',
      useAutoCaption: input.useAutoCaption !== undefined ? input.useAutoCaption : true,
      customThumbnailPath: input.customThumbnailPath || '',
      thumbnailTimestamp: input.thumbnailTimestamp || settings.thumbnailTimestamp || '00:00:02',
      thumbnailUrl: input.thumbnailUrl || '',
      localFilePath: '',
      localThumbnailPath: '',
      status: 'queued',
      stageMessage: 'Queued in shared pipeline (1 Download + 1 Upload parallel)',
      downloadProgress: 0,
      downloadSpeed: '0 B/s',
      downloadedBytes: 0,
      totalBytes: 0,
      downloadEta: '--:--',
      uploadProgress: 0,
      uploadSpeed: '0 B/s',
      uploadedBytes: 0,
      uploadEta: '--:--',
      metadata: null,
      telegramMessageId: input.telegramMessageId || null,
      telegramChatId: input.telegramChatId || (selectedChannel ? selectedChannel.chatId : settings.targetChannel),
      sourceOrigin: input.sourceOrigin || 'web',
      errorMessage: null,
      fileCleanedUp: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    dbService.createJob(job);
    logger.info('SYSTEM', `Created job #${job.id} (${job.sourceOrigin.toUpperCase()})`, job.url);
    this.emit('job:created', job);

    this.schedulePipeline();
    if (job.sourceOrigin === 'telegram' && !input.deferTelegramSync) {
      const latest = dbService.getJobById(job.id) || job;
      this.syncTelegramPipelineProgress(latest, true);
    }
    return job;
  }

  public cancelJob(jobId: string): JobRecord | null {
    this.cancelledJobIds.add(jobId);
    this.uploadReadyQueue = this.uploadReadyQueue.filter((id) => id !== jobId);
    if (this.activeDownloadJobId === jobId) {
      this.activeDownloadJobId = null;
    }
    if (this.activeUploadJobId === jobId) {
      this.activeUploadJobId = null;
    }

    downloadEngine.cancelJob(jobId);
    telegramBridge.cancelUpload(jobId);
    storageManager.unlockJobFiles(jobId);
    storageManager.cleanupTempArtifactsForJob(jobId);

    const updated = dbService.updateJob(jobId, {
      status: 'cancelled',
      stageMessage: 'Cancelled by user',
      downloadSpeed: '0 B/s',
      uploadSpeed: '0 B/s',
    });

    if (updated) {
      logger.warn('SYSTEM', `Job #${jobId} cancelled`, updated.title);
      this.emit('job:updated', updated);
      if (updated.sourceOrigin === 'telegram') {
        this.syncTelegramPipelineProgress(updated, true);
      }
    }

    this.schedulePipeline();
    return updated;
  }

  public retryJob(jobId: string): JobRecord | null {
    const existing = dbService.getJobById(jobId);
    if (!existing) return null;

    if (
      this.activeDownloadJobId === jobId ||
      this.activeUploadJobId === jobId ||
      this.uploadReadyQueue.includes(jobId)
    ) {
      return existing;
    }

    this.cancelledJobIds.delete(jobId);
    const hasRetainedVideo = Boolean(existing.localFilePath && fs.existsSync(existing.localFilePath));

    const updated = dbService.updateJob(jobId, {
      status: 'queued',
      stageMessage: hasRetainedVideo
        ? 'Retrying Telegram upload from retained local file...'
        : 'Re-queued for full download & upload',
      errorMessage: null,
      uploadProgress: 0,
      uploadSpeed: '0 B/s',
      uploadEta: '--:--',
      downloadProgress: hasRetainedVideo ? 100 : 0,
    });

    if (updated) {
      logger.info('SYSTEM', `Retrying job #${jobId}`, updated.title);
      this.emit('job:updated', updated);
      this.schedulePipeline();
      if (updated.sourceOrigin === 'telegram') {
        this.syncTelegramPipelineProgress(dbService.getJobById(jobId) || updated, true);
      }
    }
    return updated;
  }

  public getActiveStats() {
    const all = dbService.getAllJobs();
    const active = all.filter(
      (j) =>
        j &&
        ['queued', 'extracting', 'downloading', 'processing_media', 'ready_for_upload', 'uploading'].includes(
          j.status
        )
    );
    const runningWorkers = (this.activeDownloadJobId ? 1 : 0) + (this.activeUploadJobId ? 1 : 0);
    return {
      runningWorkers,
      queuedJobs: all.filter((j) => j && (j.status === 'queued' || j.status === 'ready_for_upload')).length,
      activeCount: active.length,
      completedCount: all.filter((j) => j && j.status === 'completed').length,
      failedCount: all.filter((j) => j && j.status === 'failed').length,
    };
  }

  /**
   * 2-Stage Overlapped Pipeline Scheduler:
   * - Stage A (1 Download Worker): Downloads 1 video at a time at full aria2c speed.
   * - Stage B (1 Upload Worker): Uploads 1 video at a time on the same Telegram session.
   * - Backpressure Buffer (1 video max): When multiple videos are queued, the downloader prepares
   *   at most 1 downloaded video in `uploadReadyQueue` waiting for the Upload Worker.
   */
  private schedulePipeline(): void {
    // 1. Start next Upload if the single Upload Worker is idle and a downloaded video is waiting
    while (this.activeUploadJobId === null && this.uploadReadyQueue.length > 0) {
      const nextUploadId = this.uploadReadyQueue.shift()!;
      if (this.cancelledJobIds.has(nextUploadId)) continue;
      const job = dbService.getJobById(nextUploadId);
      if (!job) continue;

      this.activeUploadJobId = nextUploadId;
      this.runUploadStage(nextUploadId).finally(() => {
        if (this.activeUploadJobId === nextUploadId) {
          this.activeUploadJobId = null;
        }
        this.schedulePipeline();
      });
      break;
    }

    // 2. Start next Download if the single Download Worker is idle AND fewer than 1 video is waiting for the uploader
    if (this.activeDownloadJobId === null && this.uploadReadyQueue.length < 1) {
      const queuedJobs = dbService
        .getAllJobs()
        .filter(
          (j) =>
            j &&
            j.status === 'queued' &&
            j.id !== this.activeDownloadJobId &&
            j.id !== this.activeUploadJobId &&
            !this.uploadReadyQueue.includes(j.id)
        )
        .reverse(); // Strict FIFO order

      const nextDownloadJob = queuedJobs[0];
      if (nextDownloadJob) {
        const downloadId = nextDownloadJob.id;
        this.activeDownloadJobId = downloadId;
        this.runDownloadStage(downloadId).finally(() => {
          if (this.activeDownloadJobId === downloadId) {
            this.activeDownloadJobId = null;
          }
          this.schedulePipeline();
        });
      }
    }
  }

  private safeUpdateJob(jobId: string, updates: Partial<JobRecord>): JobRecord | null {
    if (this.cancelledJobIds.has(jobId)) return null;
    const updated = dbService.updateJob(jobId, updates);
    if (updated) {
      this.emit('job:updated', updated);
    }
    return updated;
  }

  /**
   * Renders and dispatches an accurate, HTML-formatted live Telegram notification
   * scoped specifically to the jobs sharing (triggerJob.telegramChatId, triggerJob.telegramMessageId).
   */
  private syncTelegramPipelineProgress(triggerJob: JobRecord, forceImmediate = false): void {
    if (!triggerJob.telegramChatId || !triggerJob.telegramMessageId) return;

    const chatId = triggerJob.telegramChatId;
    const msgId = triggerJob.telegramMessageId;
    const allJobs = dbService.getAllJobs();
    const groupJobs = allJobs.filter(
      (j) => j && j.telegramChatId === chatId && j.telegramMessageId === msgId
    );
    const scopedJobs = groupJobs.length > 0 ? groupJobs : [triggerJob];

    // Case A: Single-job notification message
    if (scopedJobs.length === 1) {
      const job = scopedJobs[0].id === triggerJob.id ? triggerJob : scopedJobs[0];
      const title = escapeHtml(job.title);
      const dest = escapeHtml(job.destinationName);
      const quality = escapeHtml(String(job.quality || 'best').toUpperCase());

      if (job.status === 'queued') {
        const queuedFifo = allJobs.filter((j) => j && j.status === 'queued').reverse();
        const posIdx = queuedFifo.findIndex((j) => j.id === job.id);
        const posText = posIdx >= 0 ? `Position #${posIdx + 1}` : 'Queued';
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate: true,
          text:
            `⏳ <b>Queued in Download Pipeline</b> (<code>${posText}</code>)\n` +
            `🎬 <b>${title}</b>\n` +
            `🎞 Quality: <code>${quality}</code> · 📍 Target: <code>${dest}</code>\n` +
            `<i>Waiting for single Download Worker slot...</i>`,
        });
        return;
      }

      if (job.status === 'extracting') {
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate,
          text:
            `🔎 <b>Inspecting Stream &amp; Metadata</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `🎞 Quality: <code>${quality}</code> · 📍 Target: <code>${dest}</code>\n` +
            `<i>${escapeHtml(job.stageMessage || 'Resolving direct stream...')}</i>`,
        });
        return;
      }

      if (job.status === 'downloading') {
        const pct = job.downloadProgress || 0;
        const bar = buildProgressBar(pct);
        const dlSize =
          job.totalBytes > 0
            ? `${formatBytes(job.downloadedBytes || 0)} / ${formatBytes(job.totalBytes)}`
            : job.downloadedBytes > 0
            ? formatBytes(job.downloadedBytes)
            : 'Probing...';
        const uploadBusyHint =
          this.activeUploadJobId && this.activeUploadJobId !== job.id
            ? '📤 Upload Worker: Busy (1 upload in progress)'
            : '📤 Upload Worker: Ready (uploads next)';
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate,
          text:
            `⬇️ <b>Downloading Video</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `<code>[${bar}] ${pct.toFixed(1)}%</code>\n` +
            `📦 <code>${escapeHtml(dlSize)}</code> · ⚡ <code>${escapeHtml(job.downloadSpeed || '0 B/s')}</code> · ⏱ <code>${escapeHtml(job.downloadEta || '--:--')}</code>\n` +
            `📍 Target: <code>${dest}</code>\n` +
            `<i>${uploadBusyHint}</i>`,
        });
        return;
      }

      if (job.status === 'processing_media') {
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate: true,
          text:
            `🎞 <b>Processing Media &amp; Thumbnail</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `<i>Running FFprobe telemetry inspection &amp; JPEG thumbnail preparation...</i>`,
        });
        return;
      }

      if (job.status === 'ready_for_upload') {
        const sizeStr = job.metadata?.fileSizeFormatted || (job.totalBytes > 0 ? formatBytes(job.totalBytes) : 'Ready');
        const resStr = job.metadata?.resolution || quality;
        const durStr = job.metadata?.durationFormatted || '--:--';
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate: true,
          text:
            `📦 <b>Downloaded · Queued for Uploader (1/1)</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `📊 Size: <code>${escapeHtml(sizeStr)}</code> · 🎞 <code>${escapeHtml(resStr)}</code> · ⏱ <code>${escapeHtml(durStr)}</code>\n` +
            `<i>Waiting for current Telegram upload to finish (1 upload at a time)...</i>`,
        });
        return;
      }

      if (job.status === 'uploading') {
        const pct = job.uploadProgress || 0;
        const bar = buildProgressBar(pct);
        const upSize =
          job.totalBytes > 0
            ? `${formatBytes(job.uploadedBytes || 0)} / ${formatBytes(job.totalBytes)}`
            : formatBytes(job.uploadedBytes || 0);
        const readyNext = this.uploadReadyQueue.length > 0 ? dbService.getJobById(this.uploadReadyQueue[0]) : null;
        const downloadingNext =
          this.activeDownloadJobId && this.activeDownloadJobId !== job.id
            ? dbService.getJobById(this.activeDownloadJobId)
            : null;
        let pipelineNote = '';
        if (readyNext) {
          pipelineNote = `\n📦 <i>Next in upload queue: ${escapeHtml(readyNext.title)}</i>`;
        } else if (downloadingNext) {
          pipelineNote = `\n⬇️ <i>Downloading next: ${escapeHtml(downloadingNext.title)} (${(downloadingNext.downloadProgress || 0).toFixed(0)}%)</i>`;
        }
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: true,
          forceImmediate,
          text:
            `📤 <b>Uploading to Telegram (MTProto)</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `<code>[${bar}] ${pct.toFixed(1)}%</code>\n` +
            `📦 <code>${escapeHtml(upSize)}</code> · ⚡ <code>${escapeHtml(job.uploadSpeed || '0 B/s')}</code> · ⏱ <code>${escapeHtml(job.uploadEta || '--:--')}</code>\n` +
            `📍 Target: <code>${dest}</code>` +
            pipelineNote,
        });
        return;
      }

      if (job.status === 'completed') {
        const sizeStr = job.metadata?.fileSizeFormatted || (job.totalBytes > 0 ? formatBytes(job.totalBytes) : 'Delivered');
        const resStr = job.metadata?.resolution || quality;
        const durStr = job.metadata?.durationFormatted || '--:--';
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: false,
          allowRetry: false,
          forceImmediate: true,
          text:
            `✅ <b>Upload Complete</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `📦 Size: <code>${escapeHtml(sizeStr)}</code> · 🎞 <code>${escapeHtml(resStr)}</code> · ⏱ <code>${escapeHtml(durStr)}</code>\n` +
            `📍 Delivered to: <code>${dest}</code>`,
        });
        return;
      }

      if (job.status === 'failed') {
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: false,
          allowRetry: true,
          forceImmediate: true,
          text:
            `❌ <b>Job #${escapeHtml(job.id)} Failed</b>\n` +
            `🎬 <b>${title}</b>\n` +
            `⚠️ Reason: <code>${escapeHtml((job.errorMessage || 'Pipeline execution failed').slice(0, 140))}</code>\n\n` +
            `<i>Local files are retained if downloaded for instant retry.</i>`,
        });
        return;
      }

      if (job.status === 'cancelled') {
        telegramBridge.updateTelegramMessageProgress({
          jobId: job.id,
          telegramChatId: chatId,
          telegramMessageId: msgId,
          parseMode: 'HTML',
          allowCancel: false,
          allowRetry: true,
          forceImmediate: true,
          text: `🚫 <b>Job #${escapeHtml(job.id)} Cancelled</b>\n🎬 <b>${title}</b>`,
        });
      }
      return;
    }

    // Case B: Batch pipeline message shared by multiple jobs
    const totalCount = scopedJobs.length;
    const completedCount = scopedJobs.filter((j) => j.status === 'completed').length;
    const failedJobs = scopedJobs.filter((j) => j.status === 'failed');
    const cancelledCount = scopedJobs.filter((j) => j.status === 'cancelled').length;
    const uploadingJob = scopedJobs.find((j) => j.status === 'uploading') || null;
    const readyUploadJob = scopedJobs.find((j) => j.status === 'ready_for_upload') || null;
    const downloadingJob =
      scopedJobs.find((j) => ['extracting', 'downloading', 'processing_media'].includes(j.status)) || null;
    const queuedCount = scopedJobs.filter((j) => j.status === 'queued').length;

    const allTerminal =
      !uploadingJob && !readyUploadJob && !downloadingJob && queuedCount === 0;

    if (allTerminal) {
      const summaryIcon = failedJobs.length > 0 ? '⚠️' : '✅';
      const summaryHeader =
        failedJobs.length > 0 ? 'Batch Finished with Errors' : 'Batch Upload Complete';
      const retryTarget = failedJobs[failedJobs.length - 1];
      telegramBridge.updateTelegramMessageProgress({
        jobId: retryTarget ? retryTarget.id : triggerJob.id,
        telegramChatId: chatId,
        telegramMessageId: msgId,
        parseMode: 'HTML',
        allowCancel: false,
        allowRetry: Boolean(retryTarget),
        forceImmediate: true,
        text:
          `${summaryIcon} <b>${summaryHeader}</b>\n` +
          `📦 Uploaded: <code>${completedCount}/${totalCount}</code>` +
          (failedJobs.length > 0 ? ` · ❌ Failed: <code>${failedJobs.length}</code>` : '') +
          (cancelledCount > 0 ? ` · 🚫 Cancelled: <code>${cancelledCount}</code>` : ''),
      });
      return;
    }

    const sections: string[] = [
      `🚀 <b>Batch Pipeline</b> (<code>${completedCount}/${totalCount} Uploaded</code>)`,
    ];

    if (uploadingJob) {
      const pct = uploadingJob.uploadProgress || 0;
      const bar = buildProgressBar(pct);
      const upSize =
        uploadingJob.totalBytes > 0
          ? `${formatBytes(uploadingJob.uploadedBytes || 0)} / ${formatBytes(uploadingJob.totalBytes)}`
          : formatBytes(uploadingJob.uploadedBytes || 0);
      sections.push(
        `📤 <b>Uploading Now</b>\n` +
          `🎬 <b>${escapeHtml(uploadingJob.title)}</b>\n` +
          `<code>[${bar}] ${pct.toFixed(1)}%</code> · 📦 <code>${escapeHtml(upSize)}</code>\n` +
          `⚡ <code>${escapeHtml(uploadingJob.uploadSpeed || '0 B/s')}</code> · ⏱ <code>${escapeHtml(uploadingJob.uploadEta || '--:--')}</code>`
      );
    }

    if (readyUploadJob) {
      const readySize =
        readyUploadJob.metadata?.fileSizeFormatted ||
        (readyUploadJob.totalBytes > 0 ? formatBytes(readyUploadJob.totalBytes) : 'Ready');
      sections.push(
        `📦 <b>Queued for Uploader (1/1)</b>\n` +
          `🎬 <b>${escapeHtml(readyUploadJob.title)}</b> (<code>${escapeHtml(readySize)}</code>)`
      );
    }

    if (downloadingJob) {
      const pct = downloadingJob.downloadProgress || 0;
      const bar = buildProgressBar(pct);
      const dlSize =
        downloadingJob.totalBytes > 0
          ? `${formatBytes(downloadingJob.downloadedBytes || 0)} / ${formatBytes(downloadingJob.totalBytes)}`
          : downloadingJob.downloadedBytes > 0
          ? formatBytes(downloadingJob.downloadedBytes)
          : escapeHtml(downloadingJob.stageMessage || 'Inspecting...');
      const dlTitle =
        downloadingJob.status === 'processing_media'
          ? '🎞 <b>Processing Media (Next for Uploader)</b>'
          : uploadingJob
          ? '⬇️ <b>Downloading Next</b>'
          : '⬇️ <b>Downloading</b>';
      sections.push(
        `${dlTitle}\n` +
          `🎬 <b>${escapeHtml(downloadingJob.title)}</b>\n` +
          `<code>[${bar}] ${pct.toFixed(1)}%</code> · 📦 <code>${dlSize}</code>\n` +
          `⚡ <code>${escapeHtml(downloadingJob.downloadSpeed || '0 B/s')}</code> · ⏱ <code>${escapeHtml(downloadingJob.downloadEta || '--:--')}</code>`
      );
    }

    if (queuedCount > 0) {
      sections.push(
        `📋 <b>Download Queue</b>: <code>${queuedCount} video${queuedCount > 1 ? 's' : ''} remaining</code>`
      );
    }

    const cancelJobId =
      uploadingJob?.id || downloadingJob?.id || readyUploadJob?.id || triggerJob.id;
    telegramBridge.updateTelegramMessageProgress({
      jobId: cancelJobId,
      telegramChatId: chatId,
      telegramMessageId: msgId,
      parseMode: 'HTML',
      allowCancel: true,
      forceImmediate,
      text: sections.join('\n\n'),
    });
  }

  /**
   * Stage A: Download 1 video + extract FFprobe metadata & FFmpeg thumbnail,
   * then hand off to Upload Queue and release the Download Worker.
   */
  private async runDownloadStage(jobId: string): Promise<void> {
    let job = dbService.getJobById(jobId);
    if (!job || this.cancelledJobIds.has(jobId)) return;

    const originalPostUrl = job.url;
    storageManager.lockJobFiles(jobId);

    try {
      const hasExistingVideo = Boolean(job.localFilePath && fs.existsSync(job.localFilePath));

      if (!hasExistingVideo) {
        let activeDownloadUrl = job.url;

        // Stage 1: Resolve direct CDN/stream link or probe via yt-dlp
        job = this.safeUpdateJob(jobId, {
          status: 'extracting',
          stageMessage:
            job.extractor === 'Post Crawler'
              ? 'Resolving direct CDN video link from post page...'
              : 'Extracting stream formats & direct CDN links...',
        });
        if (!job) return;
        if (job.sourceOrigin === 'telegram') {
          this.syncTelegramPipelineProgress(job, true);
        }

        let resolvedDirect = false;

        // Fast-path for crawled post URLs: extract embedded CDN / direct MP4 link first
        if (job.extractor === 'Post Crawler') {
          try {
            const resolved = await resolveBestDirectStreamFromPost(activeDownloadUrl, job.quality);
            if (this.cancelledJobIds.has(jobId)) return;

            if (resolved.downloadUrl && resolved.downloadUrl !== activeDownloadUrl) {
              activeDownloadUrl = resolved.downloadUrl;
              resolvedDirect = true;
              logger.info(
                'DOWNLOADER',
                `Resolved post URL to direct stream for job #${jobId}: ${activeDownloadUrl}`
              );
              job = this.safeUpdateJob(jobId, {
                url: activeDownloadUrl,
                title:
                  !job.title || job.title === 'Inspecting Video Stream...'
                    ? resolved.title
                    : job.title,
                extractor: `${resolved.extractor} (${resolved.quality})`,
                thumbnailUrl: job.thumbnailUrl || resolved.thumbnail,
                stageMessage: `Resolved direct stream (${resolved.quality}) — launching aria2c`,
              });
              if (!job) return;
            }
          } catch (resolveErr: any) {
            logger.warn(
              'DOWNLOADER',
              `Direct stream fast-path note for job #${jobId}: ${resolveErr?.message}`
            );
          }
        }

        if (!resolvedDirect) {
          if (!job) return;
          try {
            const probe = await probeVideoUrl(activeDownloadUrl);
            if (!job || this.cancelledJobIds.has(jobId)) return;

            // If probe returned direct formats with HTTP URLs and URL is not natively downloadable, keep best info
            job = this.safeUpdateJob(jobId, {
              title:
                !job.title || job.title === 'Inspecting Video Stream...'
                  ? probe.title
                  : job.title,
              extractor: probe.extractor,
              thumbnailUrl: job.thumbnailUrl || probe.thumbnail,
              stageMessage: `Stream verified (${probe.extractor}) — launching aria2c`,
            });
            if (!job) return;
          } catch (probeErr: any) {
            logger.warn(
              'DOWNLOADER',
              `Initial yt-dlp probe unsupported for job #${jobId}, resolving direct CDN stream from HTML: ${probeErr?.message}`
            );
            try {
              if (!job) return;
              const resolved = await resolveBestDirectStreamFromPost(activeDownloadUrl, job.quality);
              if (this.cancelledJobIds.has(jobId)) return;

              if (resolved.downloadUrl) {
                activeDownloadUrl = resolved.downloadUrl;
                logger.info(
                  'DOWNLOADER',
                  `Fallback resolved direct CDN URL for job #${jobId}: ${activeDownloadUrl}`
                );
                job = this.safeUpdateJob(jobId, {
                  url: activeDownloadUrl,
                  title:
                    !job.title || job.title === 'Inspecting Video Stream...'
                      ? resolved.title
                      : job.title,
                  extractor: `${resolved.extractor} (${resolved.quality})`,
                  thumbnailUrl: job.thumbnailUrl || resolved.thumbnail,
                  stageMessage: `Extracted direct stream (${resolved.quality}) — launching aria2c`,
                });
                if (!job) return;
              }
            } catch {
              // Continue with downloadEngine (which also has direct-stream fallback)
            }
          }
        }

        if (!job || this.cancelledJobIds.has(jobId)) return;

        // Stage 2: Accelerated Download via aria2c (for direct CDN links) or yt-dlp + aria2c
        job = this.safeUpdateJob(jobId, {
          url: activeDownloadUrl,
          status: 'downloading',
          stageMessage: 'Starting multi-connection download (aria2c 16x)...',
        });
        if (!job) return;
        if (job.sourceOrigin === 'telegram') {
          this.syncTelegramPipelineProgress(job, true);
        }

        const downloadedPath = await downloadEngine.downloadVideo(
          jobId,
          activeDownloadUrl,
          job.formatId || job.quality,
          (prog) => {
            if (this.cancelledJobIds.has(jobId)) return;
            const u = this.safeUpdateJob(jobId, {
              status: 'downloading',
              downloadProgress: prog.percent,
              downloadSpeed: prog.speed,
              downloadedBytes: prog.downloadedBytes,
              totalBytes: prog.totalBytes,
              downloadEta: prog.eta,
              stageMessage: prog.stageMessage,
            });
            if (u && u.sourceOrigin === 'telegram') {
              this.syncTelegramPipelineProgress(u, false);
            }
          }
        );

        if (this.cancelledJobIds.has(jobId)) return;

        job = this.safeUpdateJob(jobId, {
          localFilePath: downloadedPath,
          downloadProgress: 100,
          downloadSpeed: 'Completed',
          downloadEta: '00:00',
        });
        if (!job) return;
      }

      // Stage 3: FFprobe Metadata Extraction & Post Thumbnail / FFmpeg Thumbnail Preparation
      job = this.safeUpdateJob(jobId, {
        status: 'processing_media',
        stageMessage: job.thumbnailUrl
          ? 'Extracting FFprobe telemetry & preparing post thumbnail...'
          : 'Extracting FFprobe stream telemetry & FFmpeg JPEG thumbnail...',
      });
      if (!job) return;
      if (job.sourceOrigin === 'telegram') {
        this.syncTelegramPipelineProgress(job, true);
      }

      const metadata = await extractVideoMetadata(job.localFilePath);
      let localThumbPath = job.customThumbnailPath;

      // Priority 1: Use the actual post thumbnail (from post URL or main page card) if available
      if ((!localThumbPath || !fs.existsSync(localThumbPath)) && job.thumbnailUrl) {
        try {
          localThumbPath = await downloadAndPreparePostThumbnail(
            job.thumbnailUrl,
            jobId,
            originalPostUrl
          );
        } catch (postThumbErr: any) {
          logger.warn(
            'MEDIA',
            `Post thumbnail fetch note for job #${jobId}, falling back to FFmpeg frame: ${postThumbErr?.message}`
          );
          localThumbPath = '';
        }
      }

      // Priority 2: Fallback to FFmpeg frame extraction from the video file
      if (!localThumbPath || !fs.existsSync(localThumbPath)) {
        try {
          localThumbPath = await generateThumbnail(job.localFilePath, jobId, {
            timestamp: job.thumbnailTimestamp,
          });
        } catch (thumbErr: any) {
          logger.warn('MEDIA', `FFmpeg thumbnail note for job #${jobId}`, thumbErr?.message);
          localThumbPath = '';
        }
      }

      if (!job || this.cancelledJobIds.has(jobId)) return;

      const isUploadBusy = this.activeUploadJobId !== null && this.activeUploadJobId !== jobId;
      job = this.safeUpdateJob(jobId, {
        status: 'ready_for_upload',
        metadata,
        localThumbnailPath: localThumbPath,
        totalBytes: metadata.fileSize || job.totalBytes,
        stageMessage: isUploadBusy
          ? `Downloaded (${metadata.fileSizeFormatted}) — queued for Telegram uploader (1/1)`
          : `FFprobe verified (${metadata.resolution}, ${metadata.videoCodec}) — queued for upload`,
      });
      if (!job) return;
      // Hand off to Upload Queue before syncing Telegram progress so queue inspection sees 1/1 immediately
      if (!this.uploadReadyQueue.includes(jobId)) {
        this.uploadReadyQueue.push(jobId);
      }
      if (job.sourceOrigin === 'telegram' && isUploadBusy) {
        this.syncTelegramPipelineProgress(job, true);
      }
    } catch (err: any) {
      await this.handlePipelineError(jobId, err);
    }
  }

  /**
   * Stage B: Upload 1 downloaded video to Telegram while the Download Worker downloads the next video in parallel.
   */
  private async runUploadStage(jobId: string): Promise<void> {
    let job = dbService.getJobById(jobId);
    if (!job || this.cancelledJobIds.has(jobId)) return;

    storageManager.lockJobFiles(jobId);

    try {
      const metadata = job.metadata || (await extractVideoMetadata(job.localFilePath));
      const localThumbPath = job.localThumbnailPath || job.customThumbnailPath || '';

      const settings = dbService.getSettings();
      const channels = dbService.getChannels();
      const destChannel = channels.find((c) => c.id === job!.destinationId);

      let destinationChatId = '';
      if (job.destinationId.startsWith('chat:')) {
        destinationChatId = job.destinationId.slice('chat:'.length);
      } else if (
        job.sourceOrigin === 'telegram' &&
        job.telegramChatId &&
        (!destChannel || destChannel.chatId === '@velofetch_media' || destChannel.chatId === 'me')
      ) {
        destinationChatId = job.telegramChatId;
      } else if (
        destChannel &&
        destChannel.chatId &&
        destChannel.chatId !== '@velofetch_media' &&
        destChannel.chatId !== 'me'
      ) {
        destinationChatId = destChannel.chatId;
      } else if (settings.targetChannel && settings.targetChannel !== '@velofetch_media') {
        destinationChatId = settings.targetChannel;
      } else if (job.telegramChatId && job.telegramChatId !== '@velofetch_media') {
        destinationChatId = job.telegramChatId;
      } else {
        destinationChatId = settings.targetChannel || 'me';
      }

      const finalCaption = formatMetadataCaption(
        settings.captionTemplate,
        job.title,
        metadata,
        job.useAutoCaption ? job.customCaption : job.customCaption || job.title
      );

      job = this.safeUpdateJob(jobId, {
        status: 'uploading',
        uploadProgress: 0,
        stageMessage: `Uploading to ${destinationChatId} via Wzgram (${metadata.fileSizeFormatted})...`,
      });
      if (!job) return;

      if (job.sourceOrigin === 'telegram') {
        this.syncTelegramPipelineProgress(job, true);
      }

      await bootstrapRuntimeEnvironment();

      const uploadResult = await telegramBridge.uploadVideoWithWzgram({
        jobId,
        filePath: job.localFilePath,
        thumbPath: localThumbPath,
        caption: finalCaption,
        destinationChatId,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        telegramChatId: job.telegramChatId,
        telegramMessageId: job.telegramMessageId,
      });

      if (this.cancelledJobIds.has(jobId)) return;

      const completedAt = new Date().toISOString();

      job = this.safeUpdateJob(jobId, {
        status: 'completed',
        uploadProgress: 100,
        uploadedBytes: metadata.fileSize || job.totalBytes,
        uploadSpeed: 'Delivered',
        uploadEta: '00:00',
        stageMessage: `Uploaded to ${uploadResult.destinationChatId || job.destinationName}`,
        completedAt,
      });
      if (!job) return;

      dbService.addUploadHistory({
        id: uuidv4().slice(0, 8),
        jobId: job.id,
        title: job.title,
        url: job.url,
        destinationName: job.destinationName,
        destinationChatId,
        fileSizeFormatted: metadata.fileSizeFormatted,
        resolution: metadata.resolution,
        durationFormatted: metadata.durationFormatted,
        status: 'completed',
        errorMessage: null,
        telegramMessageId: uploadResult.telegramMessageId,
        timestamp: completedAt,
      });

      storageManager.unlockJobFiles(jobId);
      storageManager.cleanupAfterSuccessfulUpload(job);

      const refreshed = dbService.getJobById(jobId);
      if (refreshed) {
        logger.info('TELEGRAM', `Job #${jobId} completed and delivered to ${destinationChatId}`, refreshed.title);
        this.emit('job:updated', refreshed);
        if (refreshed.sourceOrigin === 'telegram') {
          this.syncTelegramPipelineProgress(refreshed, true);
        }
      }
      this.emit('history:updated');
    } catch (err: any) {
      await this.handlePipelineError(jobId, err);
    } finally {
      storageManager.unlockJobFiles(jobId);
    }
  }

  private async handlePipelineError(jobId: string, err: any): Promise<void> {
    storageManager.unlockJobFiles(jobId);

    if (err?.message === 'CANCELLED_BY_USER' || this.cancelledJobIds.has(jobId)) {
      return;
    }

    const errorMessage = err?.message || 'Pipeline execution failed';
    const failedAt = new Date().toISOString();
    const failedJob = dbService.updateJob(jobId, {
      status: 'failed',
      stageMessage: `Failed: ${errorMessage.slice(0, 120)}`,
      errorMessage,
      downloadSpeed: '0 B/s',
      uploadSpeed: '0 B/s',
    });

    if (failedJob) {
      dbService.addUploadHistory({
        id: uuidv4().slice(0, 8),
        jobId: failedJob.id,
        title: failedJob.title,
        url: failedJob.url,
        destinationName: failedJob.destinationName,
        destinationChatId: failedJob.telegramChatId || '@velofetch_media',
        fileSizeFormatted: failedJob.metadata?.fileSizeFormatted || 'Unknown',
        resolution: failedJob.metadata?.resolution || 'N/A',
        durationFormatted: failedJob.metadata?.durationFormatted || '--:--',
        status: 'failed',
        errorMessage,
        telegramMessageId: null,
        timestamp: failedAt,
      });

      if (failedJob.sourceOrigin === 'telegram') {
        this.syncTelegramPipelineProgress(failedJob, true);
      }

      this.emit('job:updated', failedJob);
      this.emit('history:updated');
    }
  }
}

export const jobQueue = new JobQueueManager();
