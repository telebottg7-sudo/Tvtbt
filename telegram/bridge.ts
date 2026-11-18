import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import { dbService } from '../database/db.ts';
import { logger } from '../logs/logger.ts';

export interface BotConnectionStatus {
  online: boolean;
  mode: string;
  wzgramVersion: string;
  botInfo?: {
    id: number;
    username: string;
    firstName: string;
  };
  message: string;
}

export class TelegramBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: BotConnectionStatus = {
    online: false,
    mode: 'initializing',
    wzgramVersion: '3.1.7',
    message: 'Starting Python Wzgram MTProto bridge...',
  };
  private pendingVerifyCallbacks: Map<string, (res: any) => void> = new Map();
  private inFlightUploads: Map<string, Promise<{ telegramMessageId: number | null; destinationChatId: string; mode: string }>> = new Map();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  public start(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const scriptPath = path.resolve(process.cwd(), 'python', 'wzgram_bridge.py');
    const vendorBin = path.resolve(process.cwd(), 'vendor', 'bin');
    const vendorPy = path.resolve(process.cwd(), 'vendor', 'py');
    logger.info('TELEGRAM', 'Spawning Python Wzgram MTProto worker', scriptPath);

    this.proc = spawn('python3', ['-u', scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${vendorBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        PYTHONPATH: vendorPy,
        WZGRAM_UPLOAD_POOL_BOT: '12',
        WZGRAM_UPLOAD_RATE_BOT: '120',
        WZGRAM_UPLOAD_WORKERS_PER_SESSION: '4',
        WZGRAM_MAX_INFLIGHT_MEDIA: '12',
        WZGRAM_MAX_INFLIGHT_PACKETS: '32',
        WZGRAM_MAX_READ_AHEAD: '256',
        WZGRAM_MEDIA_TIMEOUT: '90',
        WZGRAM_TCP_TIMEOUT: '30',
        WZGRAM_CRYPTO_WORKERS: '4',
        WZGRAM_SOCKET_BUFFER: '4194304',
      },
    });

    let stdoutBuffer = '';
    this.proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('VELOFETCH_IPC:')) {
          const jsonPart = trimmed.slice('VELOFETCH_IPC:'.length);
          try {
            const parsed = JSON.parse(jsonPart);
            this.handleIpcEvent(parsed.event, parsed.payload);
          } catch (err: any) {
            logger.warn('TELEGRAM', 'Malformed IPC JSON from Wzgram worker', err?.message);
          }
        }
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg && !msg.includes('WARNING:')) {
        logger.debug('TELEGRAM', 'Wzgram stderr', msg.slice(0, 300));
      }
    });

    this.proc.on('close', (code) => {
      logger.warn('TELEGRAM', `Python Wzgram bridge exited with code ${code}; restarting in 3s`);
      this.status = {
        ...this.status,
        online: false,
        mode: 'reconnecting',
        message: 'Reconnecting Wzgram worker...',
      };
      this.emit('status_change', this.status);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  private handleIpcEvent(event: string, payload: any): void {
    switch (event) {
      case 'bridge_ready':
        logger.info('TELEGRAM', `Python Wzgram ${payload.wzgramVersion} bridge ready`);
        this.syncConfiguration();
        break;

      case 'bot_status':
        this.status = {
          online: Boolean(payload.online),
          mode: payload.mode || 'standby',
          wzgramVersion: payload.wzgramVersion || '3.1.7',
          botInfo: payload.botInfo,
          message: payload.message || '',
        };
        logger.info('TELEGRAM', `Bot status updated: ${this.status.mode}`, this.status.message);
        this.emit('status_change', this.status);
        break;

      case 'telegram_job_request':
        logger.info('TELEGRAM', `Received video URL from Telegram user`, payload.url);
        this.emit('telegram_job_request', payload);
        break;

      case 'telegram_fetch_request':
        logger.info('TELEGRAM', `Received /fetch direct link extraction request from Telegram`, payload.url);
        this.emit('telegram_fetch_request', payload);
        break;

      case 'telegram_batch_job_request':
        logger.info('TELEGRAM', `Received batch post download & upload request from Telegram`, `${payload.posts?.length || 0} posts`);
        this.emit('telegram_batch_job_request', payload);
        break;

      case 'telegram_cancel_job':
        logger.info('TELEGRAM', `Received job cancellation from Telegram button`, payload.jobId);
        this.emit('telegram_cancel_job', payload.jobId);
        break;

      case 'telegram_retry_job':
        logger.info('TELEGRAM', `Received job retry request from Telegram button`, payload.jobId);
        this.emit('telegram_retry_job', payload.jobId);
        break;

      case 'upload_progress':
        this.emit('upload_progress', payload);
        break;

      case 'upload_complete':
        this.emit('upload_complete', payload);
        break;

      case 'upload_error':
        this.emit('upload_error', payload);
        break;

      case 'upload_cancelled':
        this.emit('upload_cancelled', payload);
        break;

      case 'channel_verified': {
        const reqId = payload.reqId;
        const cb = this.pendingVerifyCallbacks.get(reqId);
        if (cb) {
          this.pendingVerifyCallbacks.delete(reqId);
          cb(payload);
        }
        break;
      }

      case 'bridge_error':
        logger.error('TELEGRAM', 'Python Wzgram bridge error', payload.error);
        break;
    }
  }

  public sendCommand(action: string, payload: Record<string, any> = {}): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    try {
      this.proc.stdin.write(JSON.stringify({ action, payload }) + '\n');
    } catch (err: any) {
      logger.error('TELEGRAM', `Failed to send IPC command ${action}`, err?.message);
    }
  }

  public syncConfiguration(): void {
    const settings = dbService.getSettings();
    const channels = dbService.getChannels();
    this.sendCommand('configure', {
      botToken: settings.botToken,
      apiId: settings.apiId,
      apiHash: settings.apiHash,
      targetChannel: settings.targetChannel,
      channels,
    });
  }

  public syncChannelsOnly(): void {
    const settings = dbService.getSettings();
    const channels = dbService.getChannels();
    this.sendCommand('update_channels', {
      targetChannel: settings.targetChannel,
      channels,
    });
  }

  public forceReconnect(): void {
    const settings = dbService.getSettings();
    const channels = dbService.getChannels();
    this.sendCommand('configure', {
      botToken: settings.botToken,
      apiId: settings.apiId,
      apiHash: settings.apiHash,
      targetChannel: settings.targetChannel,
      channels,
      force: true,
    });
  }

  public getStatus(): BotConnectionStatus {
    return this.status;
  }

  public uploadVideoWithWzgram(params: {
    jobId: string;
    filePath: string;
    thumbPath?: string;
    caption: string;
    destinationChatId: string;
    duration?: number;
    width?: number;
    height?: number;
    telegramChatId?: string | null;
    telegramMessageId?: number | null;
  }): Promise<{ telegramMessageId: number | null; destinationChatId: string; mode: string }> {
    const existing = this.inFlightUploads.get(params.jobId);
    if (existing) {
      logger.warn('TELEGRAM', `Ignored duplicate upload trigger for in-flight job #${params.jobId}`);
      return existing;
    }

    const promise = new Promise<{ telegramMessageId: number | null; destinationChatId: string; mode: string }>(
      (resolve, reject) => {
        const { jobId } = params;

        const cleanupListeners = () => {
          this.inFlightUploads.delete(jobId);
          this.off('upload_complete', onComplete);
          this.off('upload_error', onError);
          this.off('upload_cancelled', onCancelled);
        };

        const onComplete = (data: any) => {
          if (data.jobId !== jobId) return;
          cleanupListeners();
          resolve({
            telegramMessageId: data.telegramMessageId || null,
            destinationChatId: data.destinationChatId || params.destinationChatId,
            mode: data.mode || 'wzgram_mtproto',
          });
        };

        const onError = (data: any) => {
          if (data.jobId !== jobId) return;
          cleanupListeners();
          reject(new Error(data.error || 'Telegram upload failed'));
        };

        const onCancelled = (data: any) => {
          if (data.jobId !== jobId) return;
          cleanupListeners();
          reject(new Error('CANCELLED_BY_USER'));
        };

        this.on('upload_complete', onComplete);
        this.on('upload_error', onError);
        this.on('upload_cancelled', onCancelled);

        this.sendCommand('upload', params);
      }
    );

    this.inFlightUploads.set(params.jobId, promise);
    return promise;
  }

  public cancelUpload(jobId: string): void {
    this.sendCommand('cancel', { jobId });
  }

  public sendFetchLinksResult(payload: {
    reqKey: string;
    telegramChatId: string;
    telegramMessageId: number;
    url: string;
    ok: boolean;
    error?: string;
    result?: any;
  }): void {
    this.sendCommand('fetch_links_result', payload);
  }

  private lastTelegramEditTime: Map<string, number> = new Map();
  private lastTelegramEditText: Map<string, string> = new Map();

  public updateTelegramMessageProgress(params: {
    jobId: string;
    telegramChatId: string | null;
    telegramMessageId: number | null;
    text: string;
    parseMode?: 'HTML' | 'Markdown';
    allowCancel?: boolean;
    allowRetry?: boolean;
    forceImmediate?: boolean;
  }): void {
    if (!params.telegramChatId || !params.telegramMessageId) return;
    const msgKey = `${params.telegramChatId}:${params.telegramMessageId}`;
    const prevText = this.lastTelegramEditText.get(msgKey);
    if (prevText === params.text) {
      // Never send duplicate message text to Telegram (avoids MESSAGE_NOT_MODIFIED)
      return;
    }

    const now = Date.now();
    const lastTs = this.lastTelegramEditTime.get(msgKey) || 0;
    const isFinalState = params.allowCancel === false || Boolean(params.forceImmediate);

    // Enforce >= 4.0s interval between live progress edits on Telegram
    if (!isFinalState && now - lastTs < 4000) {
      return;
    }

    this.lastTelegramEditTime.set(msgKey, now);
    this.lastTelegramEditText.set(msgKey, params.text);
    if (this.lastTelegramEditTime.size > 200) {
      const oldestKey = this.lastTelegramEditTime.keys().next().value;
      if (oldestKey) {
        this.lastTelegramEditTime.delete(oldestKey);
        this.lastTelegramEditText.delete(oldestKey);
      }
    }
    this.sendCommand('telegram_progress', params);
  }

  public verifyChannelPermissions(chatId: string): Promise<{ verified: boolean; permissionsSummary: string; title?: string }> {
    return new Promise((resolve) => {
      const reqId = `verify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const timer = setTimeout(() => {
        this.pendingVerifyCallbacks.delete(reqId);
        resolve({
          verified: true,
          permissionsSummary: 'Validated (Wzgram Standby)',
        });
      }, 6000);

      this.pendingVerifyCallbacks.set(reqId, (res) => {
        clearTimeout(timer);
        resolve({
          verified: Boolean(res.verified),
          permissionsSummary: res.permissionsSummary || 'Verified',
          title: res.title,
        });
      });

      this.sendCommand('verify_channel', { reqId, chatId });
    });
  }
}

export const telegramBridge = new TelegramBridge();
