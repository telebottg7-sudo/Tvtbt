import React, { useState } from 'react';
import {
  Download,
  UploadCloud,
  Activity,
  HardDrive,
  ArrowRight,
  RotateCcw,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Bot,
  Send,
  Film,
} from 'lucide-react';
import {
  JobRecord,
  ChannelRecord,
  SystemMetrics,
  BotConnectionStatus,
  NavSection,
} from './types.ts';

interface DashboardViewProps {
  jobs: JobRecord[];
  channels: ChannelRecord[];
  metrics: SystemMetrics | null;
  botStatus: BotConnectionStatus;
  onQuickSubmit: (url: string, destinationId: string, quality: string) => Promise<void>;
  onCancelJob: (id: string) => Promise<void>;
  onRetryJob: (id: string) => Promise<void>;
  onNavigate: (section: NavSection) => void;
}

const SAMPLE_STREAMS = [
  {
    label: 'Google 1080p Sample MP4 (ForBiggerBlazes)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  },
  {
    label: 'Google 720p Sample MP4 (ForBiggerEscapes)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  },
];

export const DashboardView: React.FC<DashboardViewProps> = ({
  jobs,
  channels,
  metrics,
  botStatus,
  onQuickSubmit,
  onCancelJob,
  onRetryJob,
  onNavigate,
}) => {
  const [quickUrl, setQuickUrl] = useState('');
  const [selectedDest, setSelectedDest] = useState(
    channels.find((c) => c.isDefault)?.id || channels[0]?.id || ''
  );
  const [selectedQuality, setSelectedQuality] = useState('best');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeJobs = jobs.filter((j) =>
    ['queued', 'extracting', 'downloading', 'processing_media', 'ready_for_upload', 'uploading'].includes(j.status)
  );
  const completedJobs = jobs.filter((j) => j.status === 'completed');

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickUrl.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onQuickSubmit(quickUrl.trim(), selectedDest, selectedQuality);
      setQuickUrl('');
    } catch (err: any) {
      setSubmitError(err?.message || 'Failed to enqueue video');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top 4-Card KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>Total Downloads</span>
            <Download className="w-4 h-4 text-[#3985FF]" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {jobs.length}
          </div>
          <div className="mt-1.5 text-xs text-slate-400">
            yt-dlp <span aria-hidden="true">·</span> aria2c multi-connection
          </div>
        </div>

        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>Successful Uploads</span>
            <UploadCloud className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-display font-bold text-emerald-400 tabular-nums">
            {completedJobs.length}
          </div>
          <div className="mt-1.5 text-xs text-slate-400">
            Delivered via Wzgram MTProto
          </div>
        </div>

        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>Active Jobs</span>
            <Activity className="w-4 h-4 text-[#3985FF]" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {activeJobs.length}
          </div>
          <div className="mt-1.5 text-xs text-slate-400 tabular-nums">
            Workers: {metrics?.activeWorkers ?? 0} running <span aria-hidden="true">·</span>{' '}
            {metrics?.queuedJobs ?? 0} queued
          </div>
        </div>

        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>Storage Usage</span>
            <HardDrive className="w-4 h-4 text-[#3985FF]" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {metrics?.storage.totalUsedFormatted || '0.00 B'}
          </div>
          <div className="mt-1.5 text-xs text-slate-400 tabular-nums">
            {metrics?.storage.fileCount ?? 0} local files <span aria-hidden="true">·</span> Auto-cleanup active
          </div>
        </div>
      </div>

      {/* Quick URL Submission + Bot Connection Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        <div className="lg:col-span-2 bg-[#131722] border border-slate-800/90 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-display font-semibold text-white">
                  Quick Video URL Submission
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Dispatch a video URL directly into the shared yt-dlp + aria2c + Wzgram queue.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('new-download')}
                className="text-xs font-medium text-[#3985FF] hover:underline flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                Advanced Stream Inspector
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <form onSubmit={handleQuickSubmit} className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="url"
                  required
                  value={quickUrl}
                  onChange={(e) => setQuickUrl(e.target.value)}
                  placeholder="https://example.com/video.mp4 or YouTube / Vimeo / X link..."
                  className="flex-1 bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  {submitting ? 'Dispatching...' : 'Fetch & Upload'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Destination Channel / Chat
                  </label>
                  <select
                    value={selectedDest}
                    onChange={(e) => setSelectedDest(e.target.value)}
                    className="w-full bg-[#090B10] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-[#3985FF]"
                  >
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.name} ({ch.chatId})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Target Stream Quality
                  </label>
                  <select
                    value={selectedQuality}
                    onChange={(e) => setSelectedQuality(e.target.value)}
                    className="w-full bg-[#090B10] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-[#3985FF]"
                  >
                    <option value="best">Best Available (Auto Merge MP4)</option>
                    <option value="1080p">1080p Full HD</option>
                    <option value="720p">720p HD</option>
                    <option value="480p">480p SD</option>
                  </select>
                </div>
              </div>

              {submitError && (
                <div className="text-xs text-rose-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
            </form>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Quick test stream:</span>
            {SAMPLE_STREAMS.map((s) => (
              <button
                key={s.url}
                type="button"
                onClick={() => setQuickUrl(s.url)}
                className="text-[#3985FF] hover:underline font-medium cursor-pointer"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Bot Connection & Pipeline Health Card */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-display font-semibold text-white">
                Wzgram MTProto Status
              </h2>
              <Bot className={botStatus.online ? 'w-5 h-5 text-emerald-400' : 'w-5 h-5 text-[#3985FF]'} />
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
                <span className="text-slate-400">Connection State</span>
                <span className={botStatus.online ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {botStatus.online ? 'MTProto Polling Active' : 'Standby / Local Vault Ready'}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
                <span className="text-slate-400">Engine Version</span>
                <span className="font-mono text-slate-200 tabular-nums">
                  wzgram v{botStatus.wzgramVersion}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
                <span className="text-slate-400">Accelerated Downloader</span>
                <span className="font-mono text-slate-200 tabular-nums">
                  yt-dlp + aria2c (16x)
                </span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-slate-400">Media Inspector</span>
                <span className="font-mono text-slate-200">
                  FFprobe + FFmpeg
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
            <span className="text-xs text-slate-400 truncate pr-2" title={botStatus.message}>
              {botStatus.message}
            </span>
            <button
              onClick={() => onNavigate('settings')}
              className="text-xs font-medium text-[#3985FF] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Configure Bot
            </button>
          </div>
        </div>
      </div>

      {/* Active Download & Upload Progress Cards */}
      <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-display font-semibold text-white">
              Active Download & Upload Progress
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Live WebSocket telemetry from yt-dlp, aria2c, FFmpeg, and Wzgram workers
            </p>
          </div>
          <button
            onClick={() => onNavigate('active-jobs')}
            className="text-xs font-medium text-[#3985FF] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
          >
            View All Active Jobs ({activeJobs.length})
          </button>
        </div>

        {activeJobs.length === 0 ? (
          <div className="py-8 text-center border border-dashed border-slate-800 rounded-lg">
            <p className="text-sm text-slate-300 font-medium">No active transfers in progress</p>
            <p className="text-xs text-slate-500 mt-1">
              Submit a video URL above or send a link to your Telegram bot to watch real-time aria2c and Wzgram progress.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {activeJobs.map((job) => {
              const isUploading = job.status === 'uploading';
              const pct = isUploading ? job.uploadProgress : job.downloadProgress;
              const speed = isUploading ? job.uploadSpeed : job.downloadSpeed;
              const eta = isUploading ? job.uploadEta : job.downloadEta;
              const totalBytes = job.totalBytes || job.metadata?.fileSize || 0;
              const currentBytes = isUploading ? job.uploadedBytes || 0 : job.downloadedBytes || 0;
              const formatSize = (b: number) => {
                if (!b || b <= 0) return '0 B';
                const u = ['B', 'KB', 'MB', 'GB', 'TB'];
                let i = 0;
                let v = b;
                while (v >= 1024 && i < u.length - 1) {
                  v /= 1024;
                  i++;
                }
                return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(2)} ${u[i]}`;
              };
              const sizeLabel =
                totalBytes > 0
                  ? `${formatSize(currentBytes)} / ${formatSize(totalBytes)}`
                  : currentBytes > 0
                  ? formatSize(currentBytes)
                  : 'Calculating...';

              return (
                <div
                  key={job.id}
                  className="p-4 rounded-lg bg-[#090B10] border border-slate-800/90 space-y-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="font-mono text-[#3985FF]">#{job.id}</span>
                        <span aria-hidden="true">·</span>
                        <span>{job.sourceOrigin === 'telegram' ? 'Telegram Bot' : 'Web Dashboard'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{job.destinationName}</span>
                      </div>
                      <h3 className="text-sm font-semibold text-white truncate mt-0.5">
                        {job.title}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">{job.stageMessage}</p>
                    </div>

                    <button
                      onClick={() => onCancelJob(job.id)}
                      className="px-3 py-1.5 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums">
                      <span className="text-slate-300">
                        {isUploading ? 'Wzgram Upload' : 'aria2c Download'}: {pct.toFixed(1)}% ({sizeLabel})
                      </span>
                      <span className="text-slate-400">
                        Speed: {speed} <span aria-hidden="true">·</span> ETA: {eta}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-200 ${
                          isUploading ? 'bg-emerald-500' : 'bg-[#3985FF]'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Activity Table */}
      <div className="bg-[#131722] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <h2 className="text-base font-display font-semibold text-white">
            Recent Pipeline Activity
          </h2>
          <button
            onClick={() => onNavigate('media-library')}
            className="text-xs font-medium text-[#3985FF] hover:underline cursor-pointer"
          >
            Open Media Library
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 text-[11px] font-medium text-slate-400">
                <th className="py-3 px-6">Video Title</th>
                <th className="py-3 px-4">Origin & Target</th>
                <th className="py-3 px-4">FFprobe Telemetry</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {jobs.slice(0, 8).map((job) => (
                <tr key={job.id} className="hover:bg-slate-800/25 transition-colors">
                  <td className="py-3.5 px-6 max-w-xs">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-8 rounded bg-[#090B10] border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center">
                        {job.localThumbnailPath || job.thumbnailUrl ? (
                          <img
                            src={`/api/media/thumbnail/${job.id}`}
                            alt={job.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <Film className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-slate-100 truncate">{job.title}</div>
                        <div className="text-[11px] text-slate-500 font-mono truncate">
                          #{job.id} · {job.extractor}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-slate-300">
                    <div>{job.destinationName}</div>
                    <div className="text-[11px] text-slate-500">
                      via {job.sourceOrigin === 'telegram' ? 'Telegram Bot' : 'Web Panel'}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-slate-300">
                    {job.metadata ? (
                      <div>
                        <span>{job.metadata.resolution}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{job.metadata.videoCodec}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{job.metadata.fileSizeFormatted}</span>
                      </div>
                    ) : (
                      <span className="text-slate-500">{job.quality}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    {job.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Completed
                      </span>
                    ) : job.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Failed
                      </span>
                    ) : job.status === 'cancelled' ? (
                      <span className="text-slate-400">Cancelled</span>
                    ) : (
                      <span className="text-[#3985FF] font-mono tabular-nums">
                        {job.status === 'ready_for_upload' ? 'queued for upload' : job.status} ({Math.round(job.status === 'uploading' ? job.uploadProgress : (job.downloadProgress || job.uploadProgress))}%)
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-6 text-right">
                    {(job.status === 'failed' || job.status === 'cancelled') && (
                      <button
                        onClick={() => onRetryJob(job.id)}
                        className="px-2.5 py-1 rounded bg-[#3985FF]/15 hover:bg-[#3985FF]/25 text-[#3985FF] font-medium inline-flex items-center gap-1 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
