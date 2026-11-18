import Database from 'better-sqlite3';
import path from 'path';
import { DB_DIR, ensureDirectories, defaultConfig, AppConfig } from '../config/index.ts';

ensureDirectories();

const dbPath = path.join(DB_DIR, 'velofetch.sqlite');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'downloading'
  | 'processing_media'
  | 'ready_for_upload'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VideoMetadata {
  duration: number;
  durationFormatted: string;
  width: number;
  height: number;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  fps: number;
  bitrate: number;
  bitrateFormatted: string;
  fileSize: number;
  fileSizeFormatted: string;
}

export interface JobRecord {
  id: string;
  url: string;
  title: string;
  extractor: string;
  quality: string;
  formatId: string;
  destinationId: string;
  destinationName: string;
  customCaption: string;
  useAutoCaption: boolean;
  customThumbnailPath: string;
  thumbnailTimestamp: string;
  thumbnailUrl: string;
  localFilePath: string;
  localThumbnailPath: string;
  status: JobStatus;
  stageMessage: string;
  downloadProgress: number;
  downloadSpeed: string;
  downloadedBytes: number;
  totalBytes: number;
  downloadEta: string;
  uploadProgress: number;
  uploadSpeed: string;
  uploadedBytes: number;
  uploadEta: string;
  metadata: VideoMetadata | null;
  telegramMessageId: number | null;
  telegramChatId: string | null;
  sourceOrigin: 'web' | 'telegram';
  errorMessage: string | null;
  fileCleanedUp: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ChannelRecord {
  id: string;
  name: string;
  chatId: string;
  type: 'channel' | 'group' | 'private';
  isDefault: boolean;
  verified: boolean;
  permissionsSummary: string;
  createdAt: string;
}

export interface UploadHistoryRecord {
  id: string;
  jobId: string;
  title: string;
  url: string;
  destinationName: string;
  destinationChatId: string;
  fileSizeFormatted: string;
  resolution: string;
  durationFormatted: string;
  status: 'completed' | 'failed';
  errorMessage: string | null;
  telegramMessageId: number | null;
  timestamp: string;
}

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    extractor TEXT DEFAULT 'generic',
    quality TEXT DEFAULT 'best',
    formatId TEXT DEFAULT 'best',
    destinationId TEXT DEFAULT '',
    destinationName TEXT DEFAULT '',
    customCaption TEXT DEFAULT '',
    useAutoCaption INTEGER DEFAULT 1,
    customThumbnailPath TEXT DEFAULT '',
    thumbnailTimestamp TEXT DEFAULT '00:00:02',
    thumbnailUrl TEXT DEFAULT '',
    localFilePath TEXT DEFAULT '',
    localThumbnailPath TEXT DEFAULT '',
    status TEXT DEFAULT 'queued',
    stageMessage TEXT DEFAULT 'Waiting in queue',
    downloadProgress REAL DEFAULT 0,
    downloadSpeed TEXT DEFAULT '0 B/s',
    downloadedBytes INTEGER DEFAULT 0,
    totalBytes INTEGER DEFAULT 0,
    downloadEta TEXT DEFAULT '--:--',
    uploadProgress REAL DEFAULT 0,
    uploadSpeed TEXT DEFAULT '0 B/s',
    uploadedBytes INTEGER DEFAULT 0,
    uploadEta TEXT DEFAULT '--:--',
    metadataJson TEXT DEFAULT NULL,
    telegramMessageId INTEGER DEFAULT NULL,
    telegramChatId TEXT DEFAULT NULL,
    sourceOrigin TEXT DEFAULT 'web',
    errorMessage TEXT DEFAULT NULL,
    fileCleanedUp INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    completedAt TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    chatId TEXT NOT NULL,
    type TEXT DEFAULT 'channel',
    isDefault INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 0,
    permissionsSummary TEXT DEFAULT 'Ready for Wzgram delivery',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_history (
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    destinationName TEXT NOT NULL,
    destinationChatId TEXT NOT NULL,
    fileSizeFormatted TEXT DEFAULT '0 MB',
    resolution TEXT DEFAULT '1080p',
    durationFormatted TEXT DEFAULT '00:00',
    status TEXT NOT NULL,
    errorMessage TEXT DEFAULT NULL,
    telegramMessageId INTEGER DEFAULT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function rowToJob(row: any): JobRecord {
  let metadata: VideoMetadata | null = null;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson);
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    extractor: row.extractor,
    quality: row.quality,
    formatId: row.formatId,
    destinationId: row.destinationId,
    destinationName: row.destinationName,
    customCaption: row.customCaption,
    useAutoCaption: Boolean(row.useAutoCaption),
    customThumbnailPath: row.customThumbnailPath,
    thumbnailTimestamp: row.thumbnailTimestamp,
    thumbnailUrl: row.thumbnailUrl,
    localFilePath: row.localFilePath,
    localThumbnailPath: row.localThumbnailPath,
    status: row.status as JobStatus,
    stageMessage: row.stageMessage,
    downloadProgress: Number(row.downloadProgress || 0),
    downloadSpeed: row.downloadSpeed || '0 B/s',
    downloadedBytes: Number(row.downloadedBytes || 0),
    totalBytes: Number(row.totalBytes || 0),
    downloadEta: row.downloadEta || '--:--',
    uploadProgress: Number(row.uploadProgress || 0),
    uploadSpeed: row.uploadSpeed || '0 B/s',
    uploadedBytes: Number(row.uploadedBytes || 0),
    uploadEta: row.uploadEta || '--:--',
    metadata,
    telegramMessageId: row.telegramMessageId,
    telegramChatId: row.telegramChatId,
    sourceOrigin: (row.sourceOrigin as 'web' | 'telegram') || 'web',
    errorMessage: row.errorMessage,
    fileCleanedUp: Boolean(row.fileCleanedUp),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export const dbService = {
  getSettings(): AppConfig {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const merged: Record<string, any> = { ...defaultConfig };
    for (const r of rows) {
      try {
        merged[r.key] = JSON.parse(r.value);
      } catch {
        merged[r.key] = r.value;
      }
    }
    // Always prioritize non-empty environment variables if DB has empty credentials
    if (!merged.botToken && process.env.BOT_TOKEN) merged.botToken = process.env.BOT_TOKEN;
    if (!merged.apiId && process.env.API_ID) merged.apiId = process.env.API_ID;
    if (!merged.apiHash && process.env.API_HASH) merged.apiHash = process.env.API_HASH;
    if (!merged.targetChannel && process.env.TARGET_CHANNEL) merged.targetChannel = process.env.TARGET_CHANNEL;
    return merged as AppConfig;
  },

  saveSettings(partial: Partial<AppConfig>): AppConfig {
    const current = this.getSettings();
    const updated = { ...current, ...partial };
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const tx = db.transaction((obj: Record<string, any>) => {
      for (const [k, v] of Object.entries(obj)) {
        stmt.run(k, JSON.stringify(v));
      }
    });
    tx(updated);
    return updated;
  },

  getAllJobs(): JobRecord[] {
    const rows = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC, rowid DESC LIMIT 200').all();
    return rows.map(rowToJob);
  },

  getJobById(id: string): JobRecord | null {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? rowToJob(row) : null;
  },

  createJob(job: JobRecord): JobRecord {
    const stmt = db.prepare(`
      INSERT INTO jobs (
        id, url, title, extractor, quality, formatId, destinationId, destinationName,
        customCaption, useAutoCaption, customThumbnailPath, thumbnailTimestamp, thumbnailUrl,
        localFilePath, localThumbnailPath, status, stageMessage, downloadProgress, downloadSpeed,
        downloadedBytes, totalBytes, downloadEta, uploadProgress, uploadSpeed, uploadedBytes,
        uploadEta, metadataJson, telegramMessageId, telegramChatId, sourceOrigin, errorMessage,
        fileCleanedUp, createdAt, updatedAt, completedAt
      ) VALUES (
        @id, @url, @title, @extractor, @quality, @formatId, @destinationId, @destinationName,
        @customCaption, @useAutoCaption, @customThumbnailPath, @thumbnailTimestamp, @thumbnailUrl,
        @localFilePath, @localThumbnailPath, @status, @stageMessage, @downloadProgress, @downloadSpeed,
        @downloadedBytes, @totalBytes, @downloadEta, @uploadProgress, @uploadSpeed, @uploadedBytes,
        @uploadEta, @metadataJson, @telegramMessageId, @telegramChatId, @sourceOrigin, @errorMessage,
        @fileCleanedUp, @createdAt, @updatedAt, @completedAt
      )
    `);
    stmt.run({
      ...job,
      useAutoCaption: job.useAutoCaption ? 1 : 0,
      fileCleanedUp: job.fileCleanedUp ? 1 : 0,
      metadataJson: job.metadata ? JSON.stringify(job.metadata) : null,
    });
    return job;
  },

  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const current = this.getJobById(id);
    if (!current) return null;
    const updated: JobRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const stmt = db.prepare(`
      UPDATE jobs SET
        url = @url,
        title = @title,
        extractor = @extractor,
        quality = @quality,
        formatId = @formatId,
        destinationId = @destinationId,
        destinationName = @destinationName,
        customCaption = @customCaption,
        useAutoCaption = @useAutoCaption,
        customThumbnailPath = @customThumbnailPath,
        thumbnailTimestamp = @thumbnailTimestamp,
        thumbnailUrl = @thumbnailUrl,
        localFilePath = @localFilePath,
        localThumbnailPath = @localThumbnailPath,
        status = @status,
        stageMessage = @stageMessage,
        downloadProgress = @downloadProgress,
        downloadSpeed = @downloadSpeed,
        downloadedBytes = @downloadedBytes,
        totalBytes = @totalBytes,
        downloadEta = @downloadEta,
        uploadProgress = @uploadProgress,
        uploadSpeed = @uploadSpeed,
        uploadedBytes = @uploadedBytes,
        uploadEta = @uploadEta,
        metadataJson = @metadataJson,
        telegramMessageId = @telegramMessageId,
        telegramChatId = @telegramChatId,
        errorMessage = @errorMessage,
        fileCleanedUp = @fileCleanedUp,
        updatedAt = @updatedAt,
        completedAt = @completedAt
      WHERE id = @id
    `);
    stmt.run({
      ...updated,
      useAutoCaption: updated.useAutoCaption ? 1 : 0,
      fileCleanedUp: updated.fileCleanedUp ? 1 : 0,
      metadataJson: updated.metadata ? JSON.stringify(updated.metadata) : null,
    });
    return updated;
  },

  deleteJob(id: string): void {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  },

  getChannels(): ChannelRecord[] {
    const rows = db.prepare('SELECT * FROM channels ORDER BY isDefault DESC, createdAt ASC').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      chatId: r.chatId,
      type: r.type,
      isDefault: Boolean(r.isDefault),
      verified: Boolean(r.verified),
      permissionsSummary: r.permissionsSummary,
      createdAt: r.createdAt,
    }));
  },

  upsertChannel(channel: ChannelRecord): ChannelRecord[] {
    if (channel.isDefault) {
      db.prepare('UPDATE channels SET isDefault = 0').run();
    }
    db.prepare(`
      INSERT OR REPLACE INTO channels (id, name, chatId, type, isDefault, verified, permissionsSummary, createdAt)
      VALUES (@id, @name, @chatId, @type, @isDefault, @verified, @permissionsSummary, @createdAt)
    `).run({
      ...channel,
      isDefault: channel.isDefault ? 1 : 0,
      verified: channel.verified ? 1 : 0,
    });
    return this.getChannels();
  },

  setDefaultChannel(id: string): ChannelRecord[] {
    db.prepare('UPDATE channels SET isDefault = 0').run();
    db.prepare('UPDATE channels SET isDefault = 1 WHERE id = ?').run(id);
    return this.getChannels();
  },

  deleteChannel(id: string): ChannelRecord[] {
    db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    return this.getChannels();
  },

  getUploadHistory(): UploadHistoryRecord[] {
    return db.prepare('SELECT * FROM upload_history ORDER BY timestamp DESC LIMIT 200').all() as UploadHistoryRecord[];
  },

  addUploadHistory(entry: UploadHistoryRecord): UploadHistoryRecord {
    db.prepare(`
      INSERT INTO upload_history (
        id, jobId, title, url, destinationName, destinationChatId,
        fileSizeFormatted, resolution, durationFormatted, status,
        errorMessage, telegramMessageId, timestamp
      ) VALUES (
        @id, @jobId, @title, @url, @destinationName, @destinationChatId,
        @fileSizeFormatted, @resolution, @durationFormatted, @status,
        @errorMessage, @telegramMessageId, @timestamp
      )
    `).run(entry);
    return entry;
  },
};

// Seed or sync default destination channels
const currentSettings = dbService.getSettings();
const configuredTarget = currentSettings.targetChannel || process.env.TARGET_CHANNEL || '';
const existingChannels = dbService.getChannels();

if (existingChannels.length === 0) {
  dbService.upsertChannel({
    id: 'ch-default-main',
    name: 'Primary Target Channel',
    chatId: configuredTarget || 'me',
    type: 'channel',
    isDefault: true,
    verified: Boolean(configuredTarget),
    permissionsSummary: 'Post Messages, Upload Media, Edit Captions',
    createdAt: new Date().toISOString(),
  });
  dbService.upsertChannel({
    id: 'ch-direct-vault',
    name: 'Direct Bot Private Chat',
    chatId: 'me',
    type: 'private',
    isDefault: false,
    verified: true,
    permissionsSummary: 'Direct Bot Chat Delivery',
    createdAt: new Date().toISOString(),
  });
} else if (configuredTarget) {
  // Replace any leftover @velofetch_media placeholder with the user's real configured targetChannel
  db.prepare(`
    UPDATE channels
    SET chatId = ?, verified = 1, name = 'Primary Target Channel'
    WHERE chatId = '@velofetch_media'
  `).run(configuredTarget);

  // Also update any jobs that had @velofetch_media so retrying them uses the real destination
  db.prepare(`
    UPDATE jobs
    SET destinationName = ?
    WHERE destinationName LIKE '%@velofetch_media%'
  `).run(`Primary Target Channel (${configuredTarget})`);
}

