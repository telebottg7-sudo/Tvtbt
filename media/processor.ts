import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { THUMBNAILS_DIR } from '../config/index.ts';
import { VideoMetadata, dbService as database } from '../database/db.ts';
import { logger } from '../logs/logger.ts';

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatBitrate(bps: number): string {
  if (!bps || bps <= 0) return '0 kbps';
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1000)} kbps`;
}

function classifyResolution(width: number, height: number): string {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (longSide >= 3840 || shortSide >= 2160) return '4K UHD';
  if (longSide >= 2560 || shortSide >= 1440) return '1440p QHD';
  if (longSide >= 1920 || shortSide >= 1080) return '1080p FHD';
  if (longSide >= 1280 || shortSide >= 720) return '720p HD';
  if (longSide >= 854 || shortSide >= 480) return '480p SD';
  if (shortSide > 0) return `${shortSide}p`;
  return 'Unknown';
}

export async function extractVideoMetadata(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found for FFprobe inspection: ${filePath}`));
    }

    const stat = fs.statSync(filePath);
    const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error('MEDIA', `FFprobe failed with code ${code}`, stderr);
        return reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        const streams: any[] = parsed.streams || [];
        const format: any = parsed.format || {};

        const videoStream = streams.find((s) => s.codec_type === 'video') || {};
        const audioStream = streams.find((s) => s.codec_type === 'audio') || {};

        const duration = parseFloat(format.duration || videoStream.duration || '0') || 0;
        const width = parseInt(videoStream.width || '0', 10) || 0;
        const height = parseInt(videoStream.height || '0', 10) || 0;
        const videoCodec = (videoStream.codec_name || 'h264').toUpperCase();
        const audioCodec = (audioStream.codec_name || 'aac').toUpperCase();

        // Parse FPS from r_frame_rate or avg_frame_rate (e.g., "30000/1001" or "30/1")
        let fps = 30;
        const fpsRaw = videoStream.avg_frame_rate || videoStream.r_frame_rate || '30/1';
        if (typeof fpsRaw === 'string' && fpsRaw.includes('/')) {
          const [num, den] = fpsRaw.split('/').map(Number);
          if (den > 0) fps = Math.round((num / den) * 100) / 100;
        } else if (!isNaN(Number(fpsRaw))) {
          fps = Number(fpsRaw);
        }

        const bitrate = parseInt(format.bit_rate || videoStream.bit_rate || '0', 10) || 0;
        const fileSize = stat.size || parseInt(format.size || '0', 10) || 0;

        const metadata: VideoMetadata = {
          duration: Math.round(duration),
          durationFormatted: formatDuration(duration),
          width,
          height,
          resolution: classifyResolution(width, height),
          videoCodec,
          audioCodec,
          fps,
          bitrate,
          bitrateFormatted: formatBitrate(bitrate),
          fileSize,
          fileSizeFormatted: formatBytes(fileSize),
        };

        logger.info(
          'MEDIA',
          `FFprobe extracted metadata for ${path.basename(filePath)}`,
          `${metadata.resolution} (${width}x${height}) · ${metadata.videoCodec}/${metadata.audioCodec} · ${metadata.fps}fps · ${metadata.fileSizeFormatted}`
        );

        resolve(metadata);
      } catch (err: any) {
        logger.error('MEDIA', 'Failed to parse FFprobe JSON output', err?.message);
        reject(err);
      }
    });
  });
}

export interface ThumbnailOptions {
  timestamp?: string;
  width?: number;
  quality?: number; // 1-100, mapped to FFmpeg -q:v (2-31)
}

/**
 * Downloads the actual post thumbnail image (from og:image, itemprop=thumbnailUrl, or post card <img>)
 * and converts it via FFmpeg into a Telegram-ready baseline JPEG (<= 320px max dimension, < 200 KB)
 * so both Telegram Bot API (sendVideo) and MTProto (wzgram) display it as the video cover thumbnail.
 */
export async function downloadAndPreparePostThumbnail(
  thumbnailUrl: string,
  jobId: string,
  refererUrl?: string
): Promise<string> {
  if (!thumbnailUrl || !thumbnailUrl.startsWith('http')) {
    throw new Error('Invalid post thumbnail URL');
  }

  const rawTempPath = path.join(THUMBNAILS_DIR, `raw_post_thumb_${jobId}.img`);
  const outPath = path.join(THUMBNAILS_DIR, `thumb_${jobId}.jpg`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(thumbnailUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(refererUrl ? { Referer: refererUrl } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching post thumbnail`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length < 256) {
      throw new Error('Downloaded post thumbnail is empty or too small');
    }

    fs.writeFileSync(rawTempPath, buf);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  return new Promise((resolve, reject) => {
    // Convert any input image (.jpg, .webp, .png, .avif) into a Telegram-compliant baseline JPEG (<= 320px max side)
    const args = [
      '-y',
      '-i',
      rawTempPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-q:v',
      '3',
      outPath,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      try {
        if (fs.existsSync(rawTempPath)) fs.unlinkSync(rawTempPath);
      } catch {
        // Ignore temp cleanup
      }

      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
        logger.info('MEDIA', `Prepared actual post thumbnail for job #${jobId}`, thumbnailUrl);
        resolve(outPath);
      } else {
        reject(new Error(`FFmpeg failed to normalize post thumbnail: ${stderr.slice(-160)}`));
      }
    });
  });
}

export async function generateThumbnail(
  videoPath: string,
  jobId: string,
  options?: ThumbnailOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const settings = database.getSettings();
    const timestamp = options?.timestamp || settings.thumbnailTimestamp || '00:00:02';
    // Telegram Bot API requires video thumbnail width & height <= 320 and < 200 KB JPEG
    const targetMax = Math.min(320, options?.width || settings.thumbnailWidth || 320);
    const qualityPercent = options?.quality || settings.thumbnailQuality || 85;
    // Map 100..1% to FFmpeg MJPEG qscale 2..15
    const qscale = Math.max(2, Math.min(15, Math.round(15 - (qualityPercent / 100) * 13)));

    const outPath = path.join(THUMBNAILS_DIR, `thumb_${jobId}.jpg`);

    // Fast input seeking (-ss before -i) extracts a single JPEG frame without re-encoding the video
    const args = [
      '-y',
      '-ss',
      timestamp,
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${targetMax},iw)':'min(${targetMax},ih)':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-q:v',
      String(qscale),
      outPath,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        logger.info('MEDIA', `Generated JPEG thumbnail via FFmpeg at ${timestamp}`, outPath);
        resolve(outPath);
      } else {
        // Fallback to 00:00:00 if video is shorter than timestamp
        const fallbackArgs = [
          '-y',
          '-ss',
          '00:00:00',
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${targetMax},iw)':'min(${targetMax},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
          '-q:v',
          '4',
          outPath,
        ];
        const fallbackProc = spawn('ffmpeg', fallbackArgs);
        fallbackProc.on('close', (fbCode) => {
          if (fbCode === 0 && fs.existsSync(outPath)) {
            logger.info('MEDIA', 'Generated JPEG thumbnail via FFmpeg at 00:00:00 fallback', outPath);
            resolve(outPath);
          } else {
            logger.warn('MEDIA', 'FFmpeg thumbnail generation failed', stderr.slice(-200));
            reject(new Error('FFmpeg failed to extract thumbnail'));
          }
        });
      }
    });
  });
}

export function formatMetadataCaption(
  template: string,
  title: string,
  metadata: VideoMetadata | null,
  customCaption?: string
): string {
  if (customCaption && customCaption.trim().length > 0) {
    return customCaption.trim();
  }
  if (!metadata) {
    return `🎬 **${title}**\n⚡ Uploaded via VeloFetch`;
  }
  return template
    .replace(/\{title\}/g, title)
    .replace(/\{resolution\}/g, metadata.resolution)
    .replace(/\{width\}/g, String(metadata.width))
    .replace(/\{height\}/g, String(metadata.height))
    .replace(/\{duration\}/g, String(metadata.duration))
    .replace(/\{duration_formatted\}/g, metadata.durationFormatted)
    .replace(/\{video_codec\}/g, metadata.videoCodec)
    .replace(/\{audio_codec\}/g, metadata.audioCodec)
    .replace(/\{fps\}/g, String(metadata.fps))
    .replace(/\{bitrate\}/g, metadata.bitrateFormatted)
    .replace(/\{file_size_formatted\}/g, metadata.fileSizeFormatted);
}
