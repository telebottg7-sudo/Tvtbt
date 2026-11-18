export type NavSection =
  | 'dashboard'
  | 'new-download'
  | 'fetch-links'
  | 'active-jobs'
  | 'media-library'
  | 'upload-history'
  | 'channels'
  | 'system-monitor'
  | 'logs'
  | 'settings';

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

export interface StorageStats {
  downloadsBytes: number;
  thumbnailsBytes: number;
  tempBytes: number;
  totalUsedBytes: number;
  totalUsedFormatted: string;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskPercentUsed: number;
  activeLockedFiles: number;
  retainedFailedFiles: number;
  fileCount: number;
}

export interface SystemMetrics {
  cpuUsagePercent: number;
  cpuModel: string;
  cpuCores: number;
  loadAvg: [number, number, number];
  ramUsedBytes: number;
  ramTotalBytes: number;
  ramUsedFormatted: string;
  ramTotalFormatted: string;
  ramUsagePercent: number;
  storage: StorageStats;
  networkRxSpeed: string;
  networkTxSpeed: string;
  activeWorkers: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  uptimeSeconds: number;
  binaries: {
    ytDlp: string;
    aria2c: string;
    ffmpeg: string;
    ffprobe: string;
    wzgram: string;
  };
}

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

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  source: 'SYSTEM' | 'DOWNLOADER' | 'MEDIA' | 'TELEGRAM' | 'STORAGE' | 'API';
  message: string;
  details?: string;
}

export interface VideoFormatOption {
  formatId: string;
  label: string;
  resolution: string;
  ext: string;
  filesize: number;
  filesizeFormatted: string;
  vcodec: string;
  acodec: string;
  fps: number;
}

export interface VideoProbeInfo {
  url: string;
  title: string;
  extractor: string;
  duration: number;
  durationFormatted: string;
  thumbnail: string;
  uploader: string;
  webpageUrl: string;
  isDirectVideo: boolean;
  formats: VideoFormatOption[];
}

export interface ExtractedDirectLink {
  id: string;
  directUrl: string;
  quality: string;
  resolution: string;
  ext: string;
  filesize: number;
  filesizeFormatted: string;
  vcodec: string;
  acodec: string;
  hasAudio: boolean;
  sourceType: 'yt-dlp-direct' | 'html-download' | 'hls-stream';
  label: string;
}

export interface DiscoveredPostItem {
  id: string;
  postUrl: string;
  title: string;
  thumbnail: string;
  duration: string;
  qualityHint: string;
}

export interface PostFetchResult {
  postUrl: string;
  title: string;
  domain: string;
  extractor: string;
  duration: number;
  durationFormatted: string;
  thumbnail: string;
  pageType: 'single_post' | 'listing' | 'hybrid';
  directLinks: ExtractedDirectLink[];
  discoveredPosts: DiscoveredPostItem[];
}

