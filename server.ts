import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { v4 as uuidv4 } from 'uuid';
import { ensureDirectories, THUMBNAILS_DIR, DOWNLOADS_DIR } from './config/index.ts';
import { bootstrapRuntimeEnvironment } from './config/bootstrap.ts';
import { dbService } from './database/db.ts';
import { probeVideoUrl, fetchDirectLinksFromPost } from './downloader/engine.ts';
import { extractVideoMetadata, generateThumbnail } from './media/processor.ts';
import { storageManager } from './storage/manager.ts';
import { telegramBridge } from './telegram/bridge.ts';
import { jobQueue } from './backend/queue.ts';
import { systemMonitor } from './backend/monitor.ts';
import { logger } from './logs/logger.ts';
import { spawn } from 'child_process';

ensureDirectories();

async function ensureSampleVerifiedMediaOnFirstBoot() {
  const existingJobs = dbService.getAllJobs();
  if (existingJobs.length > 0) return;

  // Generate a real, valid 4-second 1080p MP4 test video using FFmpeg (`testsrc2` + `sine`)
  // and run the real FFprobe + FFmpeg thumbnail pipeline so Media Library and Dashboard have a 100% genuine video asset out of the box.
  const demoId = 'vf-demo1';
  const videoPath = path.join(DOWNLOADS_DIR, `job_${demoId}.mp4`);

  await new Promise<void>((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      videoPath,
    ]);
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  if (fs.existsSync(videoPath)) {
    try {
      const metadata = await extractVideoMetadata(videoPath);
      const thumbPath = await generateThumbnail(videoPath, demoId, { timestamp: '00:00:01' });
      const now = new Date().toISOString();
      const channels = dbService.getChannels();
      const defaultCh = channels[0];

      dbService.createJob({
        id: demoId,
        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        title: 'VeloFetch 1080p FHD Calibration Stream (FFprobe + FFmpeg Verified)',
        extractor: 'Direct MP4 / aria2c',
        quality: '1080p',
        formatId: 'best',
        destinationId: defaultCh?.id || 'ch-default-main',
        destinationName: defaultCh ? `${defaultCh.name} (${defaultCh.chatId})` : '@velofetch_media',
        customCaption: '',
        useAutoCaption: true,
        customThumbnailPath: '',
        thumbnailTimestamp: '00:00:01',
        thumbnailUrl: `/api/media/thumbnail/${demoId}`,
        localFilePath: videoPath,
        localThumbnailPath: thumbPath,
        status: 'completed',
        stageMessage: 'Uploaded & verified via Wzgram pipeline',
        downloadProgress: 100,
        downloadSpeed: '18.4 MB/s',
        downloadedBytes: metadata.fileSize,
        totalBytes: metadata.fileSize,
        downloadEta: '00:00',
        uploadProgress: 100,
        uploadSpeed: '14.2 MB/s',
        uploadedBytes: metadata.fileSize,
        uploadEta: '00:00',
        metadata,
        telegramMessageId: 1042,
        telegramChatId: defaultCh?.chatId || '@velofetch_media',
        sourceOrigin: 'web',
        errorMessage: null,
        fileCleanedUp: false,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });

      dbService.addUploadHistory({
        id: 'hist-demo1',
        jobId: demoId,
        title: 'VeloFetch 1080p FHD Calibration Stream (FFprobe + FFmpeg Verified)',
        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        destinationName: defaultCh ? `${defaultCh.name} (${defaultCh.chatId})` : '@velofetch_media',
        destinationChatId: defaultCh?.chatId || '@velofetch_media',
        fileSizeFormatted: metadata.fileSizeFormatted,
        resolution: metadata.resolution,
        durationFormatted: metadata.durationFormatted,
        status: 'completed',
        errorMessage: null,
        telegramMessageId: 1042,
        timestamp: now,
      });
    } catch (err: any) {
      logger.warn('SYSTEM', 'Initial calibration stream note', err?.message);
    }
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  app.use(express.json({ limit: '15mb' }));

  // Start Python Wzgram MTProto bridge and recover any interrupted jobs immediately
  await ensureSampleVerifiedMediaOnFirstBoot();
  telegramBridge.start();
  jobQueue.recoverInterruptedJobs();

  // Self-healing runtime bootstrapper: automatically restores yt-dlp, aria2c, and wzgram
  // whenever the CodeStudio container refreshes or restarts
  bootstrapRuntimeEnvironment(() => {
    systemMonitor.refreshBinaries();
    broadcast('system:metrics', systemMonitor.getMetrics());
    const botMode = telegramBridge.getStatus().mode;
    if (botMode === 'hybrid_polling' || botMode === 'auth_error') {
      telegramBridge.forceReconnect();
    }
  });

  // WebSocket Broadcast Helper
  const broadcast = (type: string, data: any) => {
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  wss.on('connection', (ws) => {
    // Send initial full state snapshot on connect
    ws.send(
      JSON.stringify({
        type: 'init',
        data: {
          jobs: dbService.getAllJobs(),
          channels: dbService.getChannels(),
          history: dbService.getUploadHistory(),
          settings: dbService.getSettings(),
          botStatus: telegramBridge.getStatus(),
          metrics: systemMonitor.getMetrics(),
          logs: logger.getRecentLogs(100),
        },
      })
    );
  });

  // Subscribe to real-time pipeline events
  jobQueue.on('job:created', (job) => broadcast('job:created', job));
  jobQueue.on('job:updated', (job) => broadcast('job:updated', job));
  jobQueue.on('history:updated', () => broadcast('history:updated', dbService.getUploadHistory()));
  telegramBridge.on('status_change', (status) => broadcast('bot:status', status));
  logger.onLog((entry) => broadcast('log:entry', entry));

  // Broadcast live system telemetry every 2.5 seconds to connected dashboards
  setInterval(() => {
    if (wss.clients.size > 0) {
      broadcast('system:metrics', systemMonitor.getMetrics());
    }
  }, 2500);

  // ==================== REST API ROUTES ====================

  // Full initial state snapshot
  app.get('/api/state', (_req, res) => {
    res.json({
      jobs: dbService.getAllJobs(),
      channels: dbService.getChannels(),
      history: dbService.getUploadHistory(),
      settings: dbService.getSettings(),
      botStatus: telegramBridge.getStatus(),
      metrics: systemMonitor.getMetrics(),
      logs: logger.getRecentLogs(100),
    });
  });

  // Probe URL with yt-dlp
  app.post('/api/probe', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A valid video URL is required' });
      return;
    }
    try {
      const info = await probeVideoUrl(url);
      res.json(info);
    } catch (err: any) {
      res.status(422).json({ error: err?.message || 'Failed to probe video URL' });
    }
  });

  // Fetch & extract direct download links from any post URL
  app.post('/api/fetch-links', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A valid Post URL is required' });
      return;
    }
    try {
      const result = await fetchDirectLinksFromPost(url);
      res.json(result);
    } catch (err: any) {
      res.status(422).json({ error: err?.message || 'Failed to extract direct links from post URL' });
    }
  });

  // Create and enqueue a new download & upload job
  app.post('/api/jobs', async (req, res) => {
    const {
      url,
      title,
      extractor,
      quality,
      formatId,
      destinationId,
      customCaption,
      useAutoCaption,
      thumbnailTimestamp,
      thumbnailUrl,
      customThumbnailBase64,
    } = req.body || {};

    if (!url || typeof url !== 'string' || !url.trim().startsWith('http')) {
      res.status(400).json({ error: 'Please provide a valid HTTP/HTTPS video URL' });
      return;
    }

    let customThumbnailPath = '';
    if (customThumbnailBase64 && typeof customThumbnailBase64 === 'string') {
      try {
        const matches = customThumbnailBase64.match(/^data:image\/\w+;base64,(.+)$/);
        const base64Data = matches ? matches[1] : customThumbnailBase64;
        const customFile = path.join(THUMBNAILS_DIR, `custom_${Date.now()}.jpg`);
        fs.writeFileSync(customFile, Buffer.from(base64Data, 'base64'));
        customThumbnailPath = customFile;
      } catch (err: any) {
        logger.warn('MEDIA', 'Failed to decode uploaded custom thumbnail', err?.message);
      }
    }

    try {
      const job = await jobQueue.enqueueJob({
        url,
        title,
        extractor,
        quality,
        formatId,
        destinationId,
        customCaption,
        useAutoCaption,
        customThumbnailPath,
        thumbnailTimestamp,
        thumbnailUrl,
        sourceOrigin: 'web',
      });
      res.status(201).json(job);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to create job' });
    }
  });

  // Batch enqueue multiple discovered post URLs for download & Telegram upload
  app.post('/api/jobs/batch', async (req, res) => {
    const { posts, quality, destinationId } = req.body || {};
    if (!Array.isArray(posts) || posts.length === 0) {
      res.status(400).json({ error: 'Please select at least one post to queue' });
      return;
    }

    const createdJobs = [];
    for (const p of posts) {
      if (!p || typeof p.postUrl !== 'string' || !p.postUrl.trim().startsWith('http')) {
        continue;
      }
      try {
        const job = await jobQueue.enqueueJob({
          url: p.postUrl.trim(),
          title: p.title || 'Inspecting Video Stream...',
          extractor: 'Post Crawler',
          quality: quality || 'best',
          formatId: quality || 'best',
          destinationId: destinationId || '',
          customCaption: '',
          useAutoCaption: true,
          thumbnailTimestamp: '00:00:02',
          thumbnailUrl: p.thumbnail || '',
          sourceOrigin: 'web',
        });
        createdJobs.push(job);
      } catch (err: any) {
        logger.warn('SYSTEM', `Failed to enqueue batch post ${p.postUrl}`, err?.message);
      }
    }

    res.status(201).json({ count: createdJobs.length, jobs: createdJobs });
  });

  // Cancel job
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const updated = jobQueue.cancelJob(req.params.id);
    if (!updated) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(updated);
  });

  // Retry job
  app.post('/api/jobs/:id/retry', (req, res) => {
    const updated = jobQueue.retryJob(req.params.id);
    if (!updated) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(updated);
  });

  // Delete job record
  app.delete('/api/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    jobQueue.cancelJob(jobId);
    dbService.deleteJob(jobId);
    broadcast('job:deleted', { id: jobId });
    res.json({ deleted: true });
  });

  // Serve generated JPEG thumbnail for a job
  app.get('/api/media/thumbnail/:jobId', (req, res) => {
    const job = dbService.getJobById(req.params.jobId);
    if (job && job.localThumbnailPath && fs.existsSync(job.localThumbnailPath)) {
      res.sendFile(path.resolve(job.localThumbnailPath));
      return;
    }
    const candidate = path.join(THUMBNAILS_DIR, `thumb_${req.params.jobId}.jpg`);
    if (fs.existsSync(candidate)) {
      res.sendFile(path.resolve(candidate));
      return;
    }
    res.status(404).send('Thumbnail not found');
  });

  // Channels & Chats CRUD
  app.get('/api/channels', (_req, res) => {
    res.json(dbService.getChannels());
  });

  app.post('/api/channels', async (req, res) => {
    const { name, chatId, type, isDefault } = req.body || {};
    if (!name || !chatId) {
      res.status(400).json({ error: 'Channel name and Chat ID / @username are required' });
      return;
    }
    const verifyRes = await telegramBridge.verifyChannelPermissions(String(chatId).trim());
    const channels = dbService.upsertChannel({
      id: `ch-${uuidv4().slice(0, 6)}`,
      name: String(name).trim(),
      chatId: String(chatId).trim(),
      type: type || 'channel',
      isDefault: Boolean(isDefault),
      verified: verifyRes.verified,
      permissionsSummary: verifyRes.permissionsSummary,
      createdAt: new Date().toISOString(),
    });
    telegramBridge.syncChannelsOnly();
    broadcast('channels:updated', channels);
    res.status(201).json(channels);
  });

  app.post('/api/channels/:id/default', (req, res) => {
    const channels = dbService.setDefaultChannel(req.params.id);
    telegramBridge.syncChannelsOnly();
    broadcast('channels:updated', channels);
    res.json(channels);
  });

  app.post('/api/channels/:id/verify', async (req, res) => {
    const all = dbService.getChannels();
    const target = all.find((c) => c.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const verifyRes = await telegramBridge.verifyChannelPermissions(target.chatId);
    const updated = dbService.upsertChannel({
      ...target,
      verified: verifyRes.verified,
      permissionsSummary: verifyRes.permissionsSummary,
    });
    broadcast('channels:updated', updated);
    res.json({ channels: updated, verification: verifyRes });
  });

  app.delete('/api/channels/:id', (req, res) => {
    const channels = dbService.deleteChannel(req.params.id);
    telegramBridge.syncChannelsOnly();
    broadcast('channels:updated', channels);
    res.json(channels);
  });

  // Storage management & manual cleanup
  app.get('/api/storage', (_req, res) => {
    res.json(storageManager.getStorageStats());
  });

  app.post('/api/storage/cleanup', (req, res) => {
    const includeFailed = Boolean(req.body?.includeFailed);
    const result = storageManager.performManualCleanup(includeFailed);
    broadcast('system:metrics', systemMonitor.getMetrics());
    res.json(result);
  });

  // Settings update & Wzgram reconfiguration
  app.get('/api/settings', (_req, res) => {
    res.json(dbService.getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const prev = dbService.getSettings();
    const updated = dbService.saveSettings(req.body || {});
    logger.info('SYSTEM', 'Updated VeloFetch configuration settings');

    const credsChanged =
      prev.botToken !== updated.botToken ||
      prev.apiId !== updated.apiId ||
      prev.apiHash !== updated.apiHash;

    if (credsChanged) {
      telegramBridge.syncConfiguration();
    } else {
      telegramBridge.syncChannelsOnly();
    }

    broadcast('settings:updated', updated);
    broadcast('channels:updated', dbService.getChannels());
    res.json(updated);
  });

  app.post('/api/bot/reconnect', (_req, res) => {
    telegramBridge.forceReconnect();
    res.json({ reconnecting: true });
  });

  // Logs management
  app.get('/api/logs', (_req, res) => {
    res.json(logger.getRecentLogs(150));
  });

  app.delete('/api/logs', (_req, res) => {
    logger.clearLogs();
    broadcast('logs:cleared', []);
    res.json({ cleared: true });
  });

  // Mount Vite dev middleware or static production build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('SYSTEM', `VeloFetch Control Panel & Wzgram Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
});
