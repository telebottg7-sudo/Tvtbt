import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DOWNLOADS_DIR } from '../config/index.ts';
import { ensureDownloaderToolsReady } from '../config/bootstrap.ts';
import { dbService } from '../database/db.ts';
import { logger } from '../logs/logger.ts';
import { formatBytes, formatDuration } from '../media/processor.ts';

function getYtDlpBinary(): string {
  const vendorPath = path.resolve(process.cwd(), 'vendor', 'bin', 'yt-dlp');
  if (fs.existsSync(vendorPath)) {
    return vendorPath;
  }
  return 'yt-dlp';
}

function hasAria2cBinary(): boolean {
  const vendorAria = path.resolve(process.cwd(), 'vendor', 'bin', 'aria2c');
  if (fs.existsSync(vendorAria)) return true;
  try {
    execSync('command -v aria2c', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

export interface DownloadProgressEvent {
  jobId: string;
  percent: number;
  speed: string;
  downloadedBytes: number;
  totalBytes: number;
  eta: string;
  stageMessage: string;
  detectedTitle?: string;
  detectedExtractor?: string;
}

const DIRECT_VIDEO_REGEX = /\.(mp4|mkv|webm|mov|avi|flv|m4v)(\?.*)?$/i;

// Cache recently probed URLs for 10 minutes so "Inspect Stream" -> "Start Download" is instant
const probeCache = new Map<string, { data: VideoProbeInfo; expiresAt: number }>();

function parseSizeStringToBytes(sizeStr: string): number {
  const m = sizeStr.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const powers: Record<string, number> = {
    B: 1,
    KIB: 1024,
    KB: 1000,
    MIB: 1024 ** 2,
    MB: 1000 ** 2,
    GIB: 1024 ** 3,
    GB: 1000 ** 3,
    TIB: 1024 ** 4,
    TB: 1000 ** 4,
  };
  return Math.round(val * (powers[unit] || 1));
}

export function isDirectVideoUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    return DIRECT_VIDEO_REGEX.test(u.pathname);
  } catch {
    return DIRECT_VIDEO_REGEX.test(rawUrl.trim());
  }
}

export async function probeVideoUrl(rawUrl: string): Promise<VideoProbeInfo> {
  const url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must begin with http:// or https://');
  }

  const cached = probeCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Fast-path for direct video links (.mp4, .mkv, .webm, .mov) — zero yt-dlp wait
  if (isDirectVideoUrl(url)) {
    const filename = path.basename(new URL(url).pathname) || 'Direct_Video_Stream.mp4';
    const ext = (path.extname(filename).replace('.', '') || 'mp4').toLowerCase();
    const directInfo: VideoProbeInfo = {
      url,
      title: decodeURIComponent(filename.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ')),
      extractor: 'Direct HTTP / aria2c',
      duration: 0,
      durationFormatted: 'Direct Stream',
      thumbnail: '',
      uploader: new URL(url).hostname,
      webpageUrl: url,
      isDirectVideo: true,
      formats: [
        {
          formatId: 'best',
          label: `Original Direct Stream (${ext.toUpperCase()} · 16x aria2c Turbo)`,
          resolution: 'Source',
          ext,
          filesize: 0,
          filesizeFormatted: 'Direct',
          vcodec: 'H264',
          acodec: 'AAC',
          fps: 30,
        },
      ],
    };
    probeCache.set(url, { data: directInfo, expiresAt: Date.now() + 10 * 60_000 });
    return directInfo;
  }

  await ensureDownloaderToolsReady();
  logger.info('DOWNLOADER', `Probing stream formats via yt-dlp`, url);

  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--socket-timeout',
      '10',
      url,
    ];

    const proc = spawn(getYtDlpBinary(), args);
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Stream extraction timed out after 20s'));
    }, 20000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0 || !stdout.trim()) {
        const errMsg = stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`;
        logger.error('DOWNLOADER', `Extraction failed for ${url}`, errMsg);
        reject(new Error(errMsg));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const duration = Number(info.duration || 0);
        const rawFormats: any[] = Array.isArray(info.formats) ? info.formats : [];

        const seenHeights = new Set<number>();
        const formats: VideoFormatOption[] = [];

        formats.push({
          formatId: 'best',
          label: 'Best Available Quality (Auto Merge Video + Audio)',
          resolution: info.height ? `${info.height}p` : 'Best',
          ext: 'mp4',
          filesize: Number(info.filesize || info.filesize_approx || 0),
          filesizeFormatted:
            formatBytes(Number(info.filesize || info.filesize_approx || 0)) || 'Auto',
          vcodec: info.vcodec || 'h264',
          acodec: info.acodec || 'aac',
          fps: Number(info.fps || 30),
        });

        const videoFormats = rawFormats
          .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
          .sort((a, b) => Number(b.height || 0) - Number(a.height || 0));

        for (const f of videoFormats) {
          const h = Number(f.height);
          if (!h || seenHeights.has(h)) continue;
          seenHeights.add(h);
          const size = Number(f.filesize || f.filesize_approx || 0);
          formats.push({
            formatId: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
            label: `${h}p ${
              h >= 2160 ? '4K UHD' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : 'SD'
            } (${(f.ext || 'mp4').toUpperCase()})`,
            resolution: `${h}p`,
            ext: 'mp4',
            filesize: size,
            filesizeFormatted: size > 0 ? formatBytes(size) : 'Stream',
            vcodec: String(f.vcodec || 'h264').split('.')[0].toUpperCase(),
            acodec: String(f.acodec !== 'none' ? f.acodec : 'AAC').split('.')[0].toUpperCase(),
            fps: Number(f.fps || 30),
          });
        }

        const result: VideoProbeInfo = {
          url,
          title: info.title || 'Untitled Video',
          extractor: info.extractor_key || info.extractor || 'generic',
          duration,
          durationFormatted: formatDuration(duration),
          thumbnail: info.thumbnail || '',
          uploader: info.uploader || info.channel || new URL(url).hostname,
          webpageUrl: info.webpage_url || url,
          isDirectVideo: info.extractor === 'generic' || isDirectVideoUrl(url),
          formats,
        };

        probeCache.set(url, { data: result, expiresAt: Date.now() + 10 * 60_000 });
        resolve(result);
      } catch (err: any) {
        logger.error('DOWNLOADER', 'Failed to parse yt-dlp JSON metadata', err?.message);
        reject(new Error('Failed to parse video metadata from extractor'));
      }
    });
  });
}

export class DownloadEngine {
  private activeProcesses: Map<string, ChildProcess> = new Map();

  public cancelJob(jobId: string): boolean {
    const proc = this.activeProcesses.get(jobId);
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }, 1000);
      this.activeProcesses.delete(jobId);
      logger.warn('DOWNLOADER', `Cancelled active download process for job ${jobId}`);
      return true;
    }
    return false;
  }

  /**
   * Direct ultra-fast aria2c C++ download for direct video URLs (.mp4, .mkv, .webm, .mov)
   * Bypasses yt-dlp process initialization completely.
   */
  private downloadDirectWithAria2c(
    jobId: string,
    url: string,
    connections: number,
    split: number,
    minSplitSize: string,
    onProgress: (ev: DownloadProgressEvent) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let ext = 'mp4';
      try {
        const pathname = new URL(url).pathname;
        const parsedExt = path.extname(pathname).replace('.', '').toLowerCase();
        if (parsedExt && /^[a-z0-9]{2,4}$/.test(parsedExt)) {
          ext = parsedExt;
        }
      } catch {
        // default mp4
      }

      const fileName = `job_${jobId}.${ext}`;
      const finalPath = path.join(DOWNLOADS_DIR, fileName);

      const args = [
        `--max-connection-per-server=${connections}`,
        `--split=${split}`,
        `--min-split-size=${minSplitSize}`,
        '--file-allocation=none',
        '--disk-cache=64M',
        '--stream-piece-selector=geom',
        '--continue=true',
        '--allow-overwrite=true',
        '--auto-file-renaming=false',
        '--check-certificate=false',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '--summary-interval=1',
        '--console-log-level=warn',
        '--dir',
        DOWNLOADS_DIR,
        '--out',
        fileName,
        url,
      ];

      logger.info(
        'DOWNLOADER',
        `Direct aria2c turbo download started for job ${jobId}`,
        `${connections} connections · ${split} segments · URL: ${url}`
      );

      const proc = spawn('aria2c', args);
      this.activeProcesses.set(jobId, proc);

      let stderr = '';

      const parseAriaOutput = (chunkStr: string) => {
        const lines = chunkStr.split(/[\r\n]+/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          // Match [#a1b2c3 12MiB/45MiB(26%) CN:16 DL:28.4MiB ETA:1s]
          const m = line.match(
            /\[#[0-9a-f]+\s+([^\s/]+)\/([^\s(]+)\((\d+)%\).*?DL:([^\s\]]+)(?:\s+ETA:([^\]]+))?\]/i
          );
          if (m) {
            const dlBytes = parseSizeStringToBytes(m[1]);
            const totBytes = parseSizeStringToBytes(m[2]);
            const pct = parseFloat(m[3]) || 0;
            const speed = m[4].endsWith('/s') ? m[4] : `${m[4]}/s`;
            const eta = m[5] || '00:01';
            onProgress({
              jobId,
              percent: Math.min(100, Math.max(0, pct)),
              speed,
              downloadedBytes: dlBytes,
              totalBytes: totBytes,
              eta,
              stageMessage: `Direct aria2c Turbo (${connections}x connections · ${speed})`,
            });
          }
        }
      };

      proc.stdout.on('data', (chunk) => parseAriaOutput(chunk.toString()));
      proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        stderr += s;
        parseAriaOutput(s);
      });

      proc.on('close', (code) => {
        this.activeProcesses.delete(jobId);
        if (code === 0 && fs.existsSync(finalPath)) {
          const stat = fs.statSync(finalPath);
          onProgress({
            jobId,
            percent: 100,
            speed: 'Completed',
            downloadedBytes: stat.size,
            totalBytes: stat.size,
            eta: '00:00',
            stageMessage: 'Direct aria2c download completed',
          });
          resolve(finalPath);
        } else {
          reject(new Error(stderr.trim().split('\n').pop() || `aria2c exited with code ${code}`));
        }
      });
    });
  }

  public async downloadVideo(
    jobId: string,
    url: string,
    qualityOrFormat: string,
    onProgress: (ev: DownloadProgressEvent) => void
  ): Promise<string> {
    await ensureDownloaderToolsReady();
    const settings = dbService.getSettings();
    const connections = Math.max(1, Math.min(16, settings.aria2cConnections || 16));
    const split = Math.max(1, Math.min(16, settings.aria2cSplit || 16));
    const minSplitSize = settings.minSplitSize || '1M';
    const aria2Available = hasAria2cBinary();

    // 1. Direct HTTP/HTTPS video files (.mp4, .mkv, .webm, .mov): bypass yt-dlp and use native C++ aria2c directly
    if (isDirectVideoUrl(url) && aria2Available) {
      try {
        return await this.downloadDirectWithAria2c(
          jobId,
          url,
          connections,
          split,
          minSplitSize,
          onProgress
        );
      } catch (directErr: any) {
        logger.warn(
          'DOWNLOADER',
          `Direct aria2c fallback to yt-dlp for job ${jobId}`,
          directErr?.message
        );
      }
    }

    // 2. High-speed yt-dlp + aria2c with concurrent HLS/DASH fragment acceleration (-N 16)
    const outTemplate = path.join(DOWNLOADS_DIR, `job_${jobId}.%(ext)s`);

    let formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (qualityOrFormat && qualityOrFormat !== 'best') {
      if (qualityOrFormat.includes('height<=')) {
        formatSelector = qualityOrFormat;
      } else if (/^\d+p?$/.test(qualityOrFormat)) {
        const h = parseInt(qualityOrFormat.replace('p', ''), 10);
        formatSelector = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
      } else {
        formatSelector = qualityOrFormat;
      }
    }

    const args = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--concurrent-fragments',
      '16',
      '--buffer-size',
      '16M',
      '--http-chunk-size',
      '10M',
      '-f',
      formatSelector,
      '--merge-output-format',
      'mp4',
      ...(aria2Available
        ? [
            '--downloader',
            'aria2c',
            '--downloader-args',
            `aria2c:-x ${connections} -s ${split} -k ${minSplitSize} --file-allocation=none --disk-cache=64M --stream-piece-selector=geom --summary-interval=1 --console-log-level=warn`,
          ]
        : []),
      '--print',
      'before_dl:VELOFETCH_META|%(title)s|%(extractor_key)s|%(filesize,filesize_approx)s',
      '--progress-template',
      'download:VELOFETCH_PROG|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '-o',
      outTemplate,
      url,
    ];

    logger.info(
      'DOWNLOADER',
      `Starting accelerated yt-dlp + aria2c download for job ${jobId}`,
      `Connections: ${connections} · Concurrent fragments: 16 · Format: ${formatSelector}`
    );

    return new Promise((resolve, reject) => {
      const proc = spawn(getYtDlpBinary(), args);
      this.activeProcesses.set(jobId, proc);

      let stderr = '';
      let detectedTitle: string | undefined;
      let detectedExtractor: string | undefined;
      let knownTotalBytes = 0;

      const parseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Parse inline metadata printed right before download starts
        if (trimmed.includes('VELOFETCH_META|')) {
          const parts = trimmed.slice(trimmed.indexOf('VELOFETCH_META|')).split('|');
          if (parts.length >= 3) {
            detectedTitle = parts[1]?.trim() || undefined;
            detectedExtractor = parts[2]?.trim() || undefined;
            const metaSize = parseInt(parts[3]?.trim() || '0', 10);
            if (metaSize > 0) {
              knownTotalBytes = metaSize;
            }
            onProgress({
              jobId,
              percent: 1,
              speed: 'Accelerating...',
              downloadedBytes: 0,
              totalBytes: knownTotalBytes,
              eta: '--:--',
              stageMessage: `Stream locked (${detectedExtractor || 'yt-dlp'}${
                knownTotalBytes > 0 ? ` · ${formatBytes(knownTotalBytes)}` : ''
              }) — 16x aria2c active`,
              detectedTitle,
              detectedExtractor,
            });
          }
          return;
        }

        // Parse custom progress template: VELOFETCH_PROG| 45.2%|123456|987654|987654| 12.4MiB/s|00:12
        if (trimmed.includes('VELOFETCH_PROG|')) {
          const idx = trimmed.indexOf('VELOFETCH_PROG|');
          const parts = trimmed.slice(idx).split('|');
          if (parts.length >= 7) {
            const rawPercent = parseFloat(parts[1].replace('%', '').trim()) || 0;
            const dlBytes = parseInt(parts[2], 10) || 0;
            const exactTotal = parseInt(parts[3], 10) || 0;
            const estTotal = parseInt(parts[4], 10) || 0;
            const totBytes = exactTotal || estTotal || knownTotalBytes || 0;
            if (totBytes > 0) knownTotalBytes = totBytes;
            const speedStr = parts[5].trim() !== 'NA' ? parts[5].trim() : 'Accelerating...';
            const etaStr = parts[6].trim() !== 'NA' ? parts[6].trim() : '--:--';
            const sizeSummary =
              totBytes > 0
                ? `${formatBytes(dlBytes)} / ${formatBytes(totBytes)}`
                : formatBytes(dlBytes);

            onProgress({
              jobId,
              percent: Math.min(100, Math.max(0, rawPercent)),
              speed: speedStr,
              downloadedBytes: dlBytes,
              totalBytes: totBytes,
              eta: etaStr,
              stageMessage: `Downloading (${sizeSummary} · ${speedStr})`,
              detectedTitle,
              detectedExtractor,
            });
          }
          return;
        }

        // Parse aria2c native readout lines:
        // [#a1b2c3 12MiB/45MiB(26%) CN:16 DL:24.5MiB ETA:2s]
        const ariaMatch = trimmed.match(
          /\[#[0-9a-f]+\s+([^\s/]+)\/([^\s(]+)\((\d+)%\).*?DL:([^\s\]]+)(?:\s+ETA:([^\]]+))?\]/i
        );
        if (ariaMatch) {
          const dlBytes = parseSizeStringToBytes(ariaMatch[1]);
          const totBytes = parseSizeStringToBytes(ariaMatch[2]);
          const pct = parseFloat(ariaMatch[3]) || 0;
          const speed = ariaMatch[4].endsWith('/s') ? ariaMatch[4] : `${ariaMatch[4]}/s`;
          const eta = ariaMatch[5] || '--:--';
          onProgress({
            jobId,
            percent: Math.min(100, Math.max(0, pct)),
            speed,
            downloadedBytes: dlBytes,
            totalBytes: totBytes,
            eta,
            stageMessage: `Accelerated aria2c download (${connections} segments · ${speed})`,
            detectedTitle,
            detectedExtractor,
          });
        }
      };

      proc.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split(/[\r\n]+/);
        for (const l of lines) parseLine(l);
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        const lines = text.split(/[\r\n]+/);
        for (const l of lines) parseLine(l);
      });

      proc.on('close', async (code) => {
        this.activeProcesses.delete(jobId);

        const files = fs.existsSync(DOWNLOADS_DIR)
          ? fs
              .readdirSync(DOWNLOADS_DIR)
              .filter(
                (f) =>
                  f.startsWith(`job_${jobId}.`) &&
                  !f.endsWith('.part') &&
                  !f.endsWith('.aria2') &&
                  !f.endsWith('.ytdl')
              )
          : [];

        if (code === 0 && files.length > 0) {
          const finalPath = path.join(DOWNLOADS_DIR, files[0]);
          const stat = fs.statSync(finalPath);
          onProgress({
            jobId,
            percent: 100,
            speed: 'Completed',
            downloadedBytes: stat.size,
            totalBytes: stat.size,
            eta: '00:00',
            stageMessage: 'Download completed',
            detectedTitle,
            detectedExtractor,
          });
          logger.info('DOWNLOADER', `Successfully downloaded video for job ${jobId}`, finalPath);
          resolve(finalPath);
        } else {
          // Automatic fallback: if yt-dlp failed (e.g. Unsupported URL on a post page), extract the direct CDN link from HTML and download via aria2c!
          if (!isDirectVideoUrl(url)) {
            try {
              const resolved = await resolveBestDirectStreamFromPost(url, qualityOrFormat);
              if (resolved.downloadUrl && resolved.downloadUrl !== url) {
                logger.info(
                  'DOWNLOADER',
                  `Resolved direct CDN stream for job ${jobId} after yt-dlp unsupported URL`,
                  resolved.downloadUrl
                );
                if (isDirectVideoUrl(resolved.downloadUrl) && aria2Available) {
                  const directPath = await this.downloadDirectWithAria2c(
                    jobId,
                    resolved.downloadUrl,
                    connections,
                    split,
                    minSplitSize,
                    onProgress
                  );
                  resolve(directPath);
                  return;
                }
              }
            } catch {
              // Proceed to reject with original error
            }
          }

          const errSummary =
            stderr.trim().split('\n').slice(-2).join(' ') || `yt-dlp exited with code ${code}`;
          logger.error('DOWNLOADER', `Download failed for job ${jobId}`, errSummary);
          reject(new Error(errSummary));
        }
      });
    });
  }
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

function resolveRelativeUrl(baseUrl: string, candidate: string): string | null {
  try {
    const cleaned = candidate
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\\//g, '/')
      .trim();
    if (!cleaned || cleaned.startsWith('javascript:') || cleaned.startsWith('data:') || cleaned.startsWith('#') || cleaned.startsWith('mailto:')) {
      return null;
    }
    const resolved = new URL(cleaned, baseUrl).toString();
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      return resolved;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeUrlForDedup(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function humanizeSlugFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || segments[0] || 'Video Post';
    const cleaned = decodeURIComponent(last)
      .replace(/\.(html|php|htm|asp|aspx)$/i, '')
      .replace(/^video-[a-z0-9]+[-_/]?/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!cleaned) return 'Video Post';
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } catch {
    return 'Video Post';
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function probeHeadContentLength(url: string, referer?: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(referer ? { Referer: referer } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const cl = Number(resp.headers.get('content-length') || 0);
    if (cl > 0) return cl;
  } catch {
    // Ignore HEAD error
  }
  return 0;
}

export async function scrapeHtmlForDirectVideoLinks(postUrl: string): Promise<{
  title?: string;
  thumbnail?: string;
  links: ExtractedDirectLink[];
  discoveredPosts: DiscoveredPostItem[];
}> {
  const links: ExtractedDirectLink[] = [];
  const discoveredMap = new Map<string, DiscoveredPostItem>();
  let title: string | undefined;
  let thumbnail: string | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    const resp = await fetch(postUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: postUrl,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return { links, discoveredPosts: [] };
    const html = await resp.text();
    const baseHost = new URL(postUrl).hostname.replace(/^www\./i, '').toLowerCase();
    const selfNorm = normalizeUrlForDedup(postUrl);

    // Extract title & og:image / itemprop thumbnailUrl
    const ogTitle =
      html.match(/<meta[^>]+(?:property=["']og:title["']|itemprop=["']name["'])[^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    if (ogTitle) {
      title = decodeHtmlEntities(ogTitle);
    }

    const ogImage =
      html.match(
        /<meta[^>]+(?:property=["']og:image(?::url|:secure_url)?["']|itemprop=["']thumbnailUrl["']|name=["']twitter:image["'])[^>]+content=["']([^"']+)["']/i
      )?.[1] ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property=["']og:image(?::url|:secure_url)?["']|itemprop=["']thumbnailUrl["']|name=["']twitter:image["'])/i
      )?.[1] ||
      html.match(/poster=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)?.[1];
    if (ogImage) {
      thumbnail = resolveRelativeUrl(postUrl, ogImage) || undefined;
    }

    const seenUrls = new Set<string>();
    const addCandidate = (rawHref: string, rawLabel?: string) => {
      const fullUrl = resolveRelativeUrl(postUrl, rawHref);
      if (!fullUrl || seenUrls.has(fullUrl)) return;
      // Ignore preview sprites/thumbnails or tiny assets
      if (/\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|woff|ttf|php|html|htm)(\?|$)/i.test(fullUrl)) return;
      seenUrls.add(fullUrl);

      const resMatch =
        (rawLabel || '').match(/\b(2160p|1440p|1080p|720p|480p|360p|240p|4k|2k)\b/i) ||
        fullUrl.match(/[-_/.](2160p|1440p|1080p|720p|480p|360p|240p)[-_/.?]/i);
      const resolution = resMatch ? resMatch[1].toLowerCase() : 'Direct';
      const sizeMatch = (rawLabel || '').match(/(\d+(?:\.\d+)?\s*(?:MB|GB|MiB|GiB))/i);
      const extMatch = fullUrl.match(/\.(mp4|mkv|webm|mov|m3u8|avi|flv)(\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';

      links.push({
        id: `html-${links.length + 1}`,
        directUrl: fullUrl,
        quality: resolution === 'Direct' ? 'best' : resolution,
        resolution,
        ext,
        filesize: sizeMatch ? parseSizeStringToBytes(sizeMatch[1]) : 0,
        filesizeFormatted: sizeMatch ? sizeMatch[1].toUpperCase() : 'Direct Link',
        vcodec: 'H264',
        acodec: 'AAC',
        hasAudio: true,
        sourceType: ext === 'm3u8' ? 'hls-stream' : 'html-download',
        label: rawLabel
          ? decodeHtmlEntities(rawLabel.replace(/<[^>]+>/g, ' '))
          : `${resolution.toUpperCase()} Direct ${ext.toUpperCase()} Download`,
      });
    };

    // 0a. Match <meta itemprop="contentUrl" content="..."> and og:video / twitter:player:stream
    const metaVideoRegex =
      /<meta\b[^>]+(?:itemprop=["']contentUrl["']|property=["']og:video(?::url|:secure_url)?["']|name=["']twitter:player:stream["'])[^>]+content=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = metaVideoRegex.exec(html)) !== null) {
      if (m[1]) addCandidate(m[1], 'CDN Direct Video Stream');
    }

    // 0b. Decode base64-encoded player iframe query params (e.g., clean-tube-player player-x.php?q=...)
    const iframeBase64Regex = /player-x\.php\?q=([A-Za-z0-9+/=%_-]+)/gi;
    while ((m = iframeBase64Regex.exec(html)) !== null) {
      try {
        const rawB64 = decodeURIComponent(m[1]);
        const decoded = decodeURIComponent(Buffer.from(rawB64, 'base64').toString('utf8'));
        const innerUrlRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^\s"'<>\\]+)?/gi;
        let im: RegExpExecArray | null;
        while ((im = innerUrlRegex.exec(decoded)) !== null) {
          addCandidate(im[0], 'Player Embedded CDN Stream');
        }
        if (!thumbnail) {
          const innerImgMatch = decoded.match(
            /https?:\/\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\]+)?/i
          );
          if (innerImgMatch?.[0]) {
            thumbnail = innerImgMatch[0];
          }
        }
      } catch {
        // Ignore malformed base64 param
      }
    }

    // 1. Match <a href="..."> tags for BOTH direct file downloads AND website video post links
    const anchorRegex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    while ((m = anchorRegex.exec(html)) !== null) {
      const attrsBefore = m[1] || '';
      const href = m[2] || '';
      const attrsAfter = m[3] || '';
      const allAttrs = `${attrsBefore} ${attrsAfter}`;
      const innerHtml = m[4] || '';
      const innerText = decodeHtmlEntities(innerHtml.replace(/<[^>]+>/g, ' '));

      // Check 1: Is this a direct downloadable video file link?
      if (
        /\.(mp4|mkv|webm|mov|avi|flv)(\?|$)/i.test(href) ||
        /\/(dload|download|dl|get_file|file)\//i.test(href) ||
        (/\b(download|mp4|1080p|720p|480p|360p|2160p)\b/i.test(innerText) &&
          /\.(mp4|mkv|webm|mov)|\/dload\/|download=/i.test(href))
      ) {
        addCandidate(href, innerText);
        continue;
      }

      // Check 2: Is this a Video Post link on a website/category/search page?
      const fullPostUrl = resolveRelativeUrl(postUrl, href);
      if (!fullPostUrl) continue;

      let parsedPostUrl: URL;
      try {
        parsedPostUrl = new URL(fullPostUrl);
      } catch {
        continue;
      }

      const linkHost = parsedPostUrl.hostname.replace(/^www\./i, '').toLowerCase();
      if (linkHost !== baseHost) continue;

      const normUrl = normalizeUrlForDedup(fullPostUrl);
      if (normUrl === selfNorm) continue;

      const pathname = parsedPostUrl.pathname;
      const fullPathAndQuery = pathname + parsedPostUrl.search;

      // Exclude non-post navigation, category, tag, actor, pagination, or static links
      if (
        /^\/?$/.test(pathname) ||
        /\/(cat|category|categories|tag|tags|pornstar|pornstars|model|models|channel|channels|user|users|profile|search|login|signup|register|terms|privacy|dmca|contact|about|faq|help|language|photos|pics|gallery|galleries|live|cams|ads|out|go|author|wp-content|wp-json|wp-admin|feed|comments|page)\b/i.test(
          pathname
        ) ||
        /\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|json|xml|rss|txt)(\?|$)/i.test(pathname) ||
        /^[/?&]*(page|p|sort|filter|o)=\d+/i.test(parsedPostUrl.search)
      ) {
        continue;
      }

      // Check if URL matches known video post URL patterns OR contains an <img> thumbnail inside the anchor
      const isKnownVideoPostPath =
        /\/(video-[a-z0-9_-]+|hd-porn\/[a-z0-9_-]+|watch\?v=[a-z0-9_-]+|videos?\/[a-z0-9_-]{3,}|v\/[a-z0-9_-]{3,}|view_video[^\s"'<>]*|movie\/[a-z0-9_-]+|clip\/[a-z0-9_-]+|post\/[a-z0-9_-]+|episode\/[a-z0-9_-]+|embed\/[a-z0-9_-]+)/i.test(
          fullPathAndQuery
        );

      const imgTagMatch = innerHtml.match(/<img\b[^>]*>/i);
      const hasThumbnailImg = Boolean(imgTagMatch);

      if (!isKnownVideoPostPath && !hasThumbnailImg) {
        continue;
      }

      // Inspect surrounding card HTML snippet for duration / quality / thumbnail / title
      const contextWindow = html.slice(
        Math.max(0, m.index - 180),
        Math.min(html.length, m.index + m[0].length + 280)
      );

      // Extract thumbnail URL if present in innerHtml or surrounding card
      let thumbCandidate = '';
      const imgSourceHtml = imgTagMatch ? imgTagMatch[0] : contextWindow;
      const thumbAttrMatch =
        imgSourceHtml.match(/(?:data-src|data-original|data-lazy|data-thumb|src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
        innerHtml.match(/(?:data-src|src)=["']([^"']+)["']/i);
      if (thumbAttrMatch && !thumbAttrMatch[1].startsWith('data:') && !/blank|spacer|pixel/i.test(thumbAttrMatch[1])) {
        thumbCandidate = resolveRelativeUrl(postUrl, thumbAttrMatch[1]) || '';
      }

      // Extract title candidate
      const attrTitle = allAttrs.match(/\btitle=["']([^"']+)["']/i)?.[1];
      const imgAlt = imgTagMatch?.[0]?.match(/\balt=["']([^"']+)["']/i)?.[1];
      let candidateTitle = decodeHtmlEntities(attrTitle || imgAlt || innerText || '');
      // Strip pure duration or resolution strings from being used as title
      if (/^(\d{1,2}:\d{2}(?::\d{2})?|1080p|720p|480p|360p|4k|hd)$/i.test(candidateTitle)) {
        candidateTitle = '';
      }

      // Extract duration & quality hint from context window
      const durMatch = contextWindow.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      const qualMatch = contextWindow.match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD)\b/i);

      const existing = discoveredMap.get(normUrl);
      if (existing) {
        if (!existing.thumbnail && thumbCandidate) existing.thumbnail = thumbCandidate;
        if (
          candidateTitle &&
          (existing.title === humanizeSlugFromUrl(fullPostUrl) ||
            candidateTitle.length > existing.title.length)
        ) {
          existing.title = candidateTitle;
        }
        if (!existing.duration && durMatch) existing.duration = durMatch[1];
        if (!existing.qualityHint && qualMatch) existing.qualityHint = qualMatch[1].toUpperCase();
      } else if (discoveredMap.size < 45) {
        discoveredMap.set(normUrl, {
          id: `post-${discoveredMap.size + 1}`,
          postUrl: fullPostUrl,
          title: candidateTitle || humanizeSlugFromUrl(fullPostUrl),
          thumbnail: thumbCandidate,
          duration: durMatch ? durMatch[1] : '',
          qualityHint: qualMatch ? qualMatch[1].toUpperCase() : 'HD',
        });
      }
    }

    // 2. Match <source src="..." label="..." res="..."> and <video src="...">
    const sourceRegex = /<(?:source|video)\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
    while ((m = sourceRegex.exec(html)) !== null) {
      const tag = m[0];
      const src = m[1];
      const labelAttr =
        tag.match(/(?:label|res|title|data-res)=["']([^"']+)["']/i)?.[1] || 'Direct Video Source';
      addCandidate(src, labelAttr);
    }

    // 3. Match direct HTTP(S) .mp4 / .m3u8 URLs inside script blocks / JSON configs
    const rawUrlRegex =
      /https?:\\?\/\\?\/[^\s"'<>\\]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^\s"'<>\\]+)?/gi;
    while ((m = rawUrlRegex.exec(html)) !== null) {
      addCandidate(m[0]);
    }
  } catch (err: any) {
    logger.debug('DOWNLOADER', `HTML direct link scrape note for ${postUrl}`, err?.message);
  }

  return {
    title,
    thumbnail,
    links,
    discoveredPosts: Array.from(discoveredMap.values()),
  };
}

export async function fetchDirectLinksFromPost(rawUrl: string): Promise<PostFetchResult> {
  const postUrl = rawUrl.trim();
  if (!postUrl.startsWith('http://') && !postUrl.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }

  await ensureDownloaderToolsReady();
  const domain = new URL(postUrl).hostname.replace(/^www\./, '');
  logger.info('DOWNLOADER', `Fetching posts & direct download links from URL`, postUrl);

  // Run yt-dlp JSON extraction and raw HTML page scraper in parallel
  const [ytDlpData, htmlScraped] = await Promise.all([
    new Promise<any | null>((resolve) => {
      const args = [
        '--dump-single-json',
        '--flat-playlist',
        '--playlist-end',
        '35',
        '--no-warnings',
        '--no-check-certificates',
        '--socket-timeout',
        '12',
        postUrl,
      ];
      const proc = spawn(getYtDlpBinary(), args);
      let stdout = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, 15000);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          try {
            resolve(JSON.parse(stdout));
            return;
          } catch {
            // fallback to null
          }
        }
        resolve(null);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    }),
    scrapeHtmlForDirectVideoLinks(postUrl),
  ]);

  const directLinks: ExtractedDirectLink[] = [];
  const seenDirectUrls = new Set<string>();
  const discoveredPosts: DiscoveredPostItem[] = [...htmlScraped.discoveredPosts];
  const seenPostNorms = new Set<string>(discoveredPosts.map((p) => normalizeUrlForDedup(p.postUrl)));

  if (ytDlpData) {
    // Check if yt-dlp returned a playlist / listing of posts
    if (ytDlpData._type === 'playlist' && Array.isArray(ytDlpData.entries)) {
      for (const entry of ytDlpData.entries) {
        const entryUrl = entry?.webpage_url || entry?.url;
        if (!entryUrl || typeof entryUrl !== 'string') continue;
        const resolvedEntryUrl = resolveRelativeUrl(postUrl, entryUrl);
        if (!resolvedEntryUrl) continue;
        const norm = normalizeUrlForDedup(resolvedEntryUrl);
        if (seenPostNorms.has(norm)) continue;
        seenPostNorms.add(norm);

        const entryThumb =
          entry.thumbnail ||
          (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
            ? entry.thumbnails[entry.thumbnails.length - 1].url
            : '');

        discoveredPosts.push({
          id: `yt-post-${discoveredPosts.length + 1}`,
          postUrl: resolvedEntryUrl,
          title: entry.title || humanizeSlugFromUrl(resolvedEntryUrl),
          thumbnail: entryThumb || '',
          duration: entry.duration ? formatDuration(Number(entry.duration)) : '',
          qualityHint: entry.height ? `${entry.height}p` : 'Video',
        });
      }
    }

    const rawFormats: any[] = Array.isArray(ytDlpData.formats) ? ytDlpData.formats : [];
    // Sort: progressive MP4 with audio first, then by height descending, then by filesize descending
    const validFormats = rawFormats
      .filter((f) => f.url && typeof f.url === 'string' && f.url.startsWith('http') && f.vcodec !== 'none')
      .sort((a, b) => {
        const aHasAudio = a.acodec && a.acodec !== 'none' ? 1 : 0;
        const bHasAudio = b.acodec && b.acodec !== 'none' ? 1 : 0;
        if (aHasAudio !== bHasAudio) return bHasAudio - aHasAudio;
        const hDiff = Number(b.height || 0) - Number(a.height || 0);
        if (hDiff !== 0) return hDiff;
        return Number(b.filesize || b.filesize_approx || 0) - Number(a.filesize || a.filesize_approx || 0);
      });

    for (const f of validFormats) {
      if (seenDirectUrls.has(f.url)) continue;
      seenDirectUrls.add(f.url);

      const h = Number(f.height || 0);
      const resLabel = h ? `${h}p` : f.format_note || f.resolution || 'Source';
      const size = Number(f.filesize || f.filesize_approx || 0);
      const hasAudio = f.acodec !== 'none';
      const ext = String(f.ext || 'mp4').toLowerCase();
      const vcodec = String(f.vcodec || 'H264').split('.')[0].toUpperCase();
      const acodec = hasAudio
        ? String(f.acodec && f.acodec !== 'unknown' ? f.acodec : 'AAC').split('.')[0].toUpperCase()
        : 'Video Only';
      const isHls = ext === 'm3u8' || String(f.protocol || '').includes('m3u8');

      directLinks.push({
        id: `yt-${f.format_id || directLinks.length + 1}`,
        directUrl: f.url,
        quality: h ? `${h}p` : 'best',
        resolution: resLabel,
        ext,
        filesize: size,
        filesizeFormatted: size > 0 ? formatBytes(size) : 'Stream',
        vcodec,
        acodec,
        hasAudio,
        sourceType: isHls ? 'hls-stream' : 'yt-dlp-direct',
        label: `${resLabel} ${
          h >= 2160 ? '4K UHD' : h >= 1440 ? '2K QHD' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : ''
        } (${ext.toUpperCase()} · ${hasAudio ? `${vcodec}+${acodec}` : `${vcodec} Video`})`.replace(/\s+/g, ' '),
      });
    }

    // If top-level ytDlpData.url is a direct link not yet in list
    if (ytDlpData.url && typeof ytDlpData.url === 'string' && !seenDirectUrls.has(ytDlpData.url)) {
      seenDirectUrls.add(ytDlpData.url);
      const size = Number(ytDlpData.filesize || ytDlpData.filesize_approx || 0);
      directLinks.unshift({
        id: 'yt-primary',
        directUrl: ytDlpData.url,
        quality: ytDlpData.height ? `${ytDlpData.height}p` : 'best',
        resolution: ytDlpData.height ? `${ytDlpData.height}p` : 'Best',
        ext: String(ytDlpData.ext || 'mp4').toLowerCase(),
        filesize: size,
        filesizeFormatted: size > 0 ? formatBytes(size) : 'Direct Stream',
        vcodec: String(ytDlpData.vcodec || 'H264').split('.')[0].toUpperCase(),
        acodec: String(ytDlpData.acodec || 'AAC').split('.')[0].toUpperCase(),
        hasAudio: true,
        sourceType: 'yt-dlp-direct',
        label: `Primary Direct Stream (${(ytDlpData.ext || 'mp4').toUpperCase()})`,
      });
    }
  }

  // Merge any additional direct download links found in the raw HTML page
  for (const hLink of htmlScraped.links) {
    if (!seenDirectUrls.has(hLink.directUrl)) {
      seenDirectUrls.add(hLink.directUrl);
      directLinks.push(hLink);
    }
  }

  // Enrich up to 10 direct links missing file size via fast parallel HEAD request
  if (directLinks.length > 0) {
    await Promise.all(
      directLinks.slice(0, 10).map(async (link) => {
        if (link.filesize <= 0 && link.sourceType !== 'hls-stream') {
          const probedBytes = await probeHeadContentLength(link.directUrl, postUrl);
          if (probedBytes > 0) {
            link.filesize = probedBytes;
            link.filesizeFormatted = formatBytes(probedBytes);
          }
        }
      })
    );
  }

  if (directLinks.length === 0 && discoveredPosts.length === 0) {
    throw new Error(
      'No direct video streams or video post links were found on this URL. Please provide a valid website, category, or video post URL.'
    );
  }

  const pageType: 'single_post' | 'listing' | 'hybrid' =
    directLinks.length > 0 && discoveredPosts.length > 0
      ? 'hybrid'
      : directLinks.length > 0
      ? 'single_post'
      : 'listing';

  const duration = Number(ytDlpData?.duration || 0);
  return {
    postUrl,
    title: ytDlpData?.title || htmlScraped.title || `Posts on ${domain}`,
    domain,
    extractor:
      ytDlpData?.extractor_key ||
      ytDlpData?.extractor ||
      (pageType === 'listing' ? 'Website Post Crawler' : 'HTML Direct Scraper'),
    duration,
    durationFormatted:
      duration > 0
        ? formatDuration(duration)
        : pageType === 'listing'
        ? `${discoveredPosts.length} Posts`
        : 'Direct File',
    thumbnail:
      ytDlpData?.thumbnail ||
      htmlScraped.thumbnail ||
      discoveredPosts.find((p) => p.thumbnail)?.thumbnail ||
      '',
    pageType,
    directLinks,
    discoveredPosts,
  };
}

function selectPreferredDirectLink(
  links: ExtractedDirectLink[],
  preferredQuality: string = 'best'
): ExtractedDirectLink {
  const targetQ = (preferredQuality || 'best').toLowerCase();
  let chosen = links[0];
  if (targetQ !== 'best') {
    const exact = links.find((l) => l.quality.toLowerCase() === targetQ);
    if (exact) {
      chosen = exact;
    } else {
      const targetH = parseInt(targetQ.replace(/\D/g, ''), 10);
      if (targetH > 0) {
        const leq = links.find((l) => {
          const lh = parseInt(l.quality.replace(/\D/g, ''), 10);
          return lh > 0 && lh <= targetH;
        });
        if (leq) chosen = leq;
      }
    }
  }
  return chosen;
}

/**
 * Given a video post URL and a preferred quality ('best', '1080p', '720p', '480p', '360p'),
 * extracts the direct CDN video download URL if available, or falls back to the post URL.
 */
export async function resolveBestDirectStreamFromPost(
  postUrl: string,
  preferredQuality: string = 'best'
): Promise<{
  downloadUrl: string;
  title: string;
  extractor: string;
  quality: string;
  thumbnail: string;
}> {
  // Fast-path: Scrape raw HTML for direct CDN video links first (< 1s, works on sites unsupported by yt-dlp like desixclip.net)
  try {
    const htmlRes = await scrapeHtmlForDirectVideoLinks(postUrl);
    if (htmlRes.links.length > 0) {
      const chosen = selectPreferredDirectLink(htmlRes.links, preferredQuality);
      return {
        downloadUrl: chosen.directUrl,
        title: htmlRes.title || humanizeSlugFromUrl(postUrl),
        extractor: `CDN Direct (${chosen.quality})`,
        quality: chosen.quality,
        thumbnail: htmlRes.thumbnail || '',
      };
    }
  } catch {
    // Continue to full fetchDirectLinksFromPost fallback
  }

  try {
    const res = await fetchDirectLinksFromPost(postUrl);
    if (res.directLinks.length > 0) {
      const chosen = selectPreferredDirectLink(res.directLinks, preferredQuality);
      return {
        downloadUrl: chosen.directUrl,
        title: res.title,
        extractor: `${res.extractor} Direct (${chosen.quality})`,
        quality: chosen.quality,
        thumbnail: res.thumbnail,
      };
    }
  } catch {
    // Fallback to normal yt-dlp post URL download
  }

  return {
    downloadUrl: postUrl,
    title: humanizeSlugFromUrl(postUrl),
    extractor: 'auto',
    quality: preferredQuality || 'best',
    thumbnail: '',
  };
}

export const downloadEngine = new DownloadEngine();
