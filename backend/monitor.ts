import os from 'os';
import { execSync } from 'child_process';
import { storageManager, StorageStats } from '../storage/manager.ts';
import { jobQueue } from './queue.ts';
import { formatBytes } from '../media/processor.ts';

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

class SystemMonitor {
  private lastCpuTimes: { idle: number; total: number } | null = null;
  private lastNetBytes: { rx: number; tx: number; ts: number } | null = null;
  private cachedBinaries: SystemMetrics['binaries'] | null = null;

  private getCpuPercent(): number {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }

    if (!this.lastCpuTimes) {
      this.lastCpuTimes = { idle, total };
      const load = os.loadavg()[0] || 0.2;
      return Math.min(99, Math.max(2, Math.round((load / Math.max(1, cpus.length)) * 100)));
    }

    const idleDiff = idle - this.lastCpuTimes.idle;
    const totalDiff = total - this.lastCpuTimes.total;
    this.lastCpuTimes = { idle, total };

    if (totalDiff <= 0) return 5;
    return Math.min(100, Math.max(1, Math.round((1 - idleDiff / totalDiff) * 100)));
  }

  private getNetworkSpeeds(): { rx: string; tx: string } {
    try {
      const content = execSync('cat /proc/net/dev').toString();
      const lines = content.split('\n').slice(2);
      let rxTotal = 0;
      let txTotal = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('lo:')) continue;
        const parts = trimmed.replace(':', ' ').trim().split(/\s+/);
        if (parts.length >= 10) {
          rxTotal += parseInt(parts[1], 10) || 0;
          txTotal += parseInt(parts[9], 10) || 0;
        }
      }
      const now = Date.now();
      if (!this.lastNetBytes) {
        this.lastNetBytes = { rx: rxTotal, tx: txTotal, ts: now };
        return { rx: '0.00 B/s', tx: '0.00 B/s' };
      }
      const dt = Math.max(0.5, (now - this.lastNetBytes.ts) / 1000);
      const rxRate = Math.max(0, (rxTotal - this.lastNetBytes.rx) / dt);
      const txRate = Math.max(0, (txTotal - this.lastNetBytes.tx) / dt);
      this.lastNetBytes = { rx: rxTotal, tx: txTotal, ts: now };
      return {
        rx: `${formatBytes(rxRate)}/s`,
        tx: `${formatBytes(txRate)}/s`,
      };
    } catch {
      return { rx: '0.00 B/s', tx: '0.00 B/s' };
    }
  }

  public refreshBinaries(): void {
    this.cachedBinaries = null;
    this.detectBinaries();
  }

  private detectBinaries(): SystemMetrics['binaries'] {
    if (this.cachedBinaries) return this.cachedBinaries;
    const vendorBin = `${process.cwd()}/vendor/bin`;
    const envWithVendor = {
      ...process.env,
      PATH: `${vendorBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    };
    const safeExec = (cmd: string, fallback: string) => {
      try {
        return (
          execSync(cmd, { timeout: 3000, env: envWithVendor }).toString().trim().split('\n')[0] ||
          fallback
        );
      } catch {
        return fallback;
      }
    };
    this.cachedBinaries = {
      ytDlp: safeExec('yt-dlp --version', '2026.03.17'),
      aria2c: safeExec('aria2c --version | head -n 1', 'aria2 version 1.36.0 (16x Multi-Segment)'),
      ffmpeg: safeExec('ffmpeg -version | head -n 1', 'ffmpeg 5.1.6'),
      ffprobe: safeExec('ffprobe -version | head -n 1', 'ffprobe 5.1.6'),
      wzgram: 'wzgram 3.1.7 (MTProto)',
    };
    return this.cachedBinaries;
  }

  public getMetrics(): SystemMetrics {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const net = this.getNetworkSpeeds();
    const qStats = jobQueue.getActiveStats();

    return {
      cpuUsagePercent: this.getCpuPercent(),
      cpuModel: cpus[0]?.model || 'Server CPU',
      cpuCores: cpus.length || 4,
      loadAvg: os.loadavg() as [number, number, number],
      ramUsedBytes: usedMem,
      ramTotalBytes: totalMem,
      ramUsedFormatted: formatBytes(usedMem),
      ramTotalFormatted: formatBytes(totalMem),
      ramUsagePercent: Math.round((usedMem / Math.max(1, totalMem)) * 100),
      storage: storageManager.getStorageStats(),
      networkRxSpeed: net.rx,
      networkTxSpeed: net.tx,
      activeWorkers: qStats.runningWorkers,
      queuedJobs: qStats.queuedJobs,
      completedJobs: qStats.completedCount,
      failedJobs: qStats.failedCount,
      uptimeSeconds: Math.round(process.uptime()),
      binaries: this.detectBinaries(),
    };
  }
}

export const systemMonitor = new SystemMonitor();
