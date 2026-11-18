import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { DOWNLOADS_DIR, THUMBNAILS_DIR, TEMP_DIR, STORAGE_ROOT } from '../config/index.ts';
import { dbService, JobRecord } from '../database/db.ts';
import { logger } from '../logs/logger.ts';
import { formatBytes } from '../media/processor.ts';

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

function getDirSize(dirPath: string): { bytes: number; count: number } {
  if (!fs.existsSync(dirPath)) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = getDirSize(fullPath);
      bytes += sub.bytes;
      count += sub.count;
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        bytes += stat.size;
        count += 1;
      } catch {
        // Ignore transient files
      }
    }
  }
  return { bytes, count };
}

export class StorageManager {
  private activeJobIds: Set<string> = new Set();

  public lockJobFiles(jobId: string): void {
    this.activeJobIds.add(jobId);
  }

  public unlockJobFiles(jobId: string): void {
    this.activeJobIds.delete(jobId);
  }

  public isJobActive(jobId: string): boolean {
    return this.activeJobIds.has(jobId);
  }

  /**
   * Automatic cleanup after confirmed successful upload
   */
  public cleanupAfterSuccessfulUpload(job: JobRecord): void {
    const settings = dbService.getSettings();
    if (!settings.autoCleanupAfterUpload) {
      logger.info('STORAGE', `Auto-cleanup disabled; retaining files for job ${job.id}`);
      return;
    }

    if (this.isJobActive(job.id)) {
      logger.warn('STORAGE', `Skipped cleanup for active job ${job.id}`);
      return;
    }

    let cleanedAny = false;
    if (job.localFilePath && fs.existsSync(job.localFilePath)) {
      try {
        fs.unlinkSync(job.localFilePath);
        cleanedAny = true;
        logger.info('STORAGE', `Deleted source video after confirmed upload`, path.basename(job.localFilePath));
      } catch (err: any) {
        logger.error('STORAGE', `Failed to delete video file ${job.localFilePath}`, err?.message);
      }
    }

    // Remove temporaryaria2/part files matching job ID
    this.cleanupTempArtifactsForJob(job.id);

    dbService.updateJob(job.id, { fileCleanedUp: cleanedAny });
  }

  public cleanupTempArtifactsForJob(jobId: string): void {
    for (const dir of [DOWNLOADS_DIR, TEMP_DIR]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const isJobTempArtifact =
          file.includes(jobId) &&
          (file.endsWith('.part') ||
            file.endsWith('.aria2') ||
            file.endsWith('.ytdl') ||
            file.startsWith(`seg_${jobId}_`));
        if (isJobTempArtifact) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch {
            // Ignore
          }
        }
      }
    }
  }

  /**
   * Manual cleanup triggered from Web Dashboard
   * Never deletes files belonging to currently running jobs or retained failed uploads (unless includeFailed=true)
   */
  public performManualCleanup(includeFailed = false): { deletedFiles: number; freedBytes: number; freedFormatted: string } {
    const jobs = dbService.getAllJobs();
    const protectedPaths = new Set<string>();

    for (const job of jobs) {
      const isRunning = ['queued', 'extracting', 'downloading', 'processing_media', 'ready_for_upload', 'uploading'].includes(job.status);
      if (isRunning || this.isJobActive(job.id)) {
        if (job.localFilePath) protectedPaths.add(path.resolve(job.localFilePath));
        if (job.localThumbnailPath) protectedPaths.add(path.resolve(job.localThumbnailPath));
      } else if (job.status === 'failed' && !includeFailed) {
        // Retain files for failed uploads so user can retry
        if (job.localFilePath) protectedPaths.add(path.resolve(job.localFilePath));
        if (job.localThumbnailPath) protectedPaths.add(path.resolve(job.localThumbnailPath));
      }
    }

    let deletedFiles = 0;
    let freedBytes = 0;

    for (const dir of [DOWNLOADS_DIR, TEMP_DIR]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.resolve(dir, entry);
        // Check if any active job ID is part of this filename
        const belongsToActiveJob = Array.from(this.activeJobIds).some((id) => entry.includes(id));
        if (protectedPaths.has(fullPath) || belongsToActiveJob) {
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            freedBytes += stat.size;
            fs.unlinkSync(fullPath);
            deletedFiles++;
          }
        } catch {
          // Ignore
        }
      }
    }

    logger.info(
      'STORAGE',
      `Manual storage cleanup completed`,
      `Removed ${deletedFiles} files (${formatBytes(freedBytes)} freed)`
    );

    return {
      deletedFiles,
      freedBytes,
      freedFormatted: formatBytes(freedBytes),
    };
  }

  public getStorageStats(): StorageStats {
    const dl = getDirSize(DOWNLOADS_DIR);
    const th = getDirSize(THUMBNAILS_DIR);
    const tmp = getDirSize(TEMP_DIR);
    const totalUsedBytes = dl.bytes + th.bytes + tmp.bytes;

    let diskTotalBytes = 50 * 1024 * 1024 * 1024;
    let diskFreeBytes = 35 * 1024 * 1024 * 1024;
    let diskPercentUsed = 30;

    try {
      const dfOut = execSync(`df -B1 "${STORAGE_ROOT}" | tail -n 1`).toString().trim().split(/\s+/);
      if (dfOut.length >= 5) {
        diskTotalBytes = parseInt(dfOut[1], 10) || diskTotalBytes;
        diskFreeBytes = parseInt(dfOut[3], 10) || diskFreeBytes;
        diskPercentUsed = parseInt(dfOut[4].replace('%', ''), 10) || 0;
      }
    } catch {
      // Use fallback disk metrics
    }

    const jobs = dbService.getAllJobs();
    const retainedFailedFiles = jobs.filter(
      (j) => j.status === 'failed' && j.localFilePath && fs.existsSync(j.localFilePath)
    ).length;

    return {
      downloadsBytes: dl.bytes,
      thumbnailsBytes: th.bytes,
      tempBytes: tmp.bytes,
      totalUsedBytes,
      totalUsedFormatted: formatBytes(totalUsedBytes),
      diskTotalBytes,
      diskFreeBytes,
      diskPercentUsed,
      activeLockedFiles: this.activeJobIds.size,
      retainedFailedFiles,
      fileCount: dl.count + th.count + tmp.count,
    };
  }
}

export const storageManager = new StorageManager();
