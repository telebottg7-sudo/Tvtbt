import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export interface AppConfig {
  botToken: string;
  apiId: string;
  apiHash: string;
  targetChannel: string;
  maxConcurrentJobs: number;
  aria2cConnections: number;
  aria2cSplit: number;
  minSplitSize: string;
  defaultQuality: string;
  thumbnailTimestamp: string;
  thumbnailWidth: number;
  thumbnailQuality: number;
  captionTemplate: string;
  autoCleanupAfterUpload: boolean;
  retainFailedFiles: boolean;
  maxStorageGb: number;
}

export const STORAGE_ROOT = path.resolve(process.cwd(), 'storage');
export const DOWNLOADS_DIR = path.join(STORAGE_ROOT, 'downloads');
export const THUMBNAILS_DIR = path.join(STORAGE_ROOT, 'thumbnails');
export const TEMP_DIR = path.join(STORAGE_ROOT, 'temp');
export const DB_DIR = path.resolve(process.cwd(), 'database');
export const LOGS_DIR = path.resolve(process.cwd(), 'logs');

export function ensureDirectories(): void {
  for (const dir of [STORAGE_ROOT, DOWNLOADS_DIR, THUMBNAILS_DIR, TEMP_DIR, DB_DIR, LOGS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export const defaultConfig: AppConfig = {
  botToken: process.env.BOT_TOKEN || '',
  apiId: process.env.API_ID || '',
  apiHash: process.env.API_HASH || '',
  targetChannel: process.env.TARGET_CHANNEL || '',
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10),
  aria2cConnections: parseInt(process.env.ARIA2C_CONNECTIONS || '16', 10),
  aria2cSplit: 16,
  minSplitSize: '1M',
  defaultQuality: 'best',
  thumbnailTimestamp: '00:00:02',
  thumbnailWidth: 640,
  thumbnailQuality: 85,
  captionTemplate: '🎬 **{title}**\n\n📐 Resolution: `{resolution}` ({width}x{height})\n⏱ Duration: `{duration_formatted}`\n🎞 Codec: `{video_codec}` / `{audio_codec}`\n📦 Size: `{file_size_formatted}`\n⚡ via VeloFetch',
  autoCleanupAfterUpload: process.env.AUTO_CLEANUP_AFTER_UPLOAD !== 'false',
  retainFailedFiles: true,
  maxStorageGb: 25,
};
