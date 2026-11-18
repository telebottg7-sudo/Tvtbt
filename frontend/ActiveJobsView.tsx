import React, { useState } from 'react';
import {
  XCircle,
  RotateCcw,
  Trash2,
  Download,
  UploadCloud,
  AlertTriangle,
  CheckCircle2,
  PlusCircle,
} from 'lucide-react';
import { JobRecord, NavSection } from './types.ts';

interface ActiveJobsViewProps {
  jobs: JobRecord[];
  onCancelJob: (id: string) => Promise<void>;
  onRetryJob: (id: string) => Promise<void>;
  onDeleteJob: (id: string) => Promise<void>;
  onNavigate: (section: NavSection) => void;
}

function formatBytesUi(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(2)} ${units[idx]}`;
}

export const ActiveJobsView: React.FC<ActiveJobsViewProps> = ({
  jobs,
  onCancelJob,
  onRetryJob,
  onDeleteJob,
  onNavigate,
}) => {
  const [filter, setFilter] = useState<'active' | 'failed' | 'all'>('active');

  const filteredJobs = jobs.filter((j) => {
    if (filter === 'active') {
      return ['queued', 'extracting', 'downloading', 'processing_media', 'ready_for_upload', 'uploading'].includes(
        j.status
      );
    }
    if (filter === 'failed') {
      return j.status === 'failed' || j.status === 'cancelled';
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header & Interactive Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#131722] border border-slate-800/90 rounded-xl p-5">
        <div>
          <h2 className="text-base font-display font-semibold text-white">
            Shared Pipeline Job Queue
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time synchronized jobs across the Telegram Bot and Web Control Panel
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#090B10] border border-slate-800 rounded-lg">
            <button
              onClick={() => setFilter('active')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === 'active'
                  ? 'bg-[#3985FF] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Active Transfers
            </button>
            <button
              onClick={() => setFilter('failed')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === 'failed'
                  ? 'bg-[#3985FF] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Failed / Cancelled
            </button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === 'all'
                  ? 'bg-[#3985FF] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              All Jobs ({jobs.length})
            </button>
          </div>

          <button
            onClick={() => onNavigate('new-download')}
            className="px-3.5 py-2 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            New Job
          </button>
        </div>
      </div>

      {/* Jobs List */}
      {filteredJobs.length === 0 ? (
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-12 text-center">
          <p className="text-sm font-medium text-slate-200">
            No jobs matching "{filter}" filter
          </p>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            Start a new video download from the web dashboard or send a video URL directly to the Telegram bot.
          </p>
          <button
            onClick={() => onNavigate('new-download')}
            className="mt-4 px-4 py-2 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] text-white text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            Dispatch Video URL
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map((job) => {
            const isActive = [
              'queued',
              'extracting',
              'downloading',
              'processing_media',
              'ready_for_upload',
              'uploading',
            ].includes(job.status);

            const totalBytes = job.totalBytes || job.metadata?.fileSize || 0;
            const dlBytes =
              job.downloadProgress >= 100 && totalBytes > 0 ? totalBytes : job.downloadedBytes || 0;
            const ulBytes =
              job.uploadProgress >= 100 && totalBytes > 0 ? totalBytes : job.uploadedBytes || 0;

            const dlSizeLabel =
              totalBytes > 0
                ? `${formatBytesUi(dlBytes)} / ${formatBytesUi(totalBytes)}`
                : dlBytes > 0
                ? formatBytesUi(dlBytes)
                : 'Pending';

            const ulSizeLabel =
              totalBytes > 0
                ? `${formatBytesUi(ulBytes)} / ${formatBytesUi(totalBytes)}`
                : ulBytes > 0
                ? formatBytesUi(ulBytes)
                : 'Pending';

            return (
              <div
                key={job.id}
                className="bg-[#131722] border border-slate-800/90 rounded-xl p-5 space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono text-[#3985FF] font-semibold">#{job.id}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Origin: {job.sourceOrigin === 'telegram' ? 'Telegram Bot' : 'Web Panel'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Target: {job.destinationName}</span>
                      <span aria-hidden="true">·</span>
                      <span>Quality: {job.quality}</span>
                      {totalBytes > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-300">
                            File Size: {formatBytesUi(totalBytes)}
                          </span>
                        </>
                      )}
                    </div>

                    <h3 className="text-sm font-semibold text-white mt-1 break-words">
                      {job.title}
                    </h3>
                    <div className="text-xs text-slate-500 font-mono truncate mt-0.5">
                      {job.url}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 shrink-0">
                    {isActive && (
                      <button
                        onClick={() => onCancelJob(job.id)}
                        className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                    )}

                    {(job.status === 'failed' || job.status === 'cancelled') && (
                      <button
                        onClick={() => onRetryJob(job.id)}
                        className="px-3 py-1.5 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Retry Pipeline
                      </button>
                    )}

                    <button
                      onClick={() => onDeleteJob(job.id)}
                      title="Delete job record"
                      className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Dual Progress Bars: Download (yt-dlp + aria2c) & Upload (Wzgram) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  {/* Download Progress */}
                  <div className="p-3.5 rounded-lg bg-[#090B10] border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 font-medium flex items-center gap-1.5">
                        <Download className="w-3.5 h-3.5 text-[#3985FF]" />
                        1. yt-dlp + aria2c Download
                      </span>
                      <span className="font-mono tabular-nums text-[#3985FF] font-semibold">
                        {job.downloadProgress.toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#3985FF] transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(0, job.downloadProgress))}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
                      <span>Size: {dlSizeLabel}</span>
                      <span>
                        Speed: {job.downloadSpeed} · ETA: {job.downloadEta}
                      </span>
                    </div>
                  </div>

                  {/* Upload Progress */}
                  <div className="p-3.5 rounded-lg bg-[#090B10] border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 font-medium flex items-center gap-1.5">
                        <UploadCloud className="w-3.5 h-3.5 text-emerald-400" />
                        2. Wzgram MTProto Upload
                      </span>
                      <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                        {job.uploadProgress.toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(0, job.uploadProgress))}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
                      <span>Size: {ulSizeLabel}</span>
                      <span>
                        Speed: {job.uploadSpeed} · ETA: {job.uploadEta}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Stage Status / Error Details */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <div className="flex items-center gap-2 text-slate-300">
                    {job.status === 'completed' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : job.status === 'failed' ? (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : null}
                    <span>{job.stageMessage}</span>
                  </div>

                  {job.metadata && (
                    <div className="text-slate-400 font-mono tabular-nums">
                      {job.metadata.resolution} ({job.metadata.width}x{job.metadata.height}) ·{' '}
                      {job.metadata.videoCodec}/{job.metadata.audioCodec} · {job.metadata.fps}fps ·{' '}
                      {job.metadata.fileSizeFormatted}
                    </div>
                  )}
                </div>

                {job.errorMessage && (
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 font-mono">
                    Error Detail: {job.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
