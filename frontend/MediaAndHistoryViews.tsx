import React, { useState } from 'react';
import {
  Film,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Search,
  Clock,
  HardDrive,
  ExternalLink,
} from 'lucide-react';
import { JobRecord, UploadHistoryRecord } from './types.ts';

interface MediaLibraryProps {
  jobs: JobRecord[];
  onRetryJob: (id: string) => Promise<void>;
}

export const MediaLibraryView: React.FC<MediaLibraryProps> = ({ jobs, onRetryJob }) => {
  const [search, setSearch] = useState('');

  const mediaJobs = jobs.filter(
    (j) =>
      (j.title.toLowerCase().includes(search.toLowerCase()) ||
        j.url.toLowerCase().includes(search.toLowerCase())) &&
      (j.metadata !== null || j.status === 'completed' || j.status === 'failed')
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#131722] border border-slate-800/90 rounded-xl p-5">
        <div>
          <h2 className="text-base font-display font-semibold text-white">
            Processed Media Library
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            FFmpeg-extracted JPEG thumbnails and FFprobe video stream metadata
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by title or URL..."
            className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 outline-none"
          />
        </div>
      </div>

      {mediaJobs.length === 0 ? (
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-12 text-center">
          <Film className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-sm font-medium text-slate-200">No processed media items found</p>
          <p className="text-xs text-slate-400 mt-1">
            Downloaded videos inspected by FFprobe and FFmpeg will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {mediaJobs.map((job) => {
            const meta = job.metadata;
            return (
              <div
                key={job.id}
                className="bg-[#131722] border border-slate-800/90 rounded-xl overflow-hidden flex flex-col justify-between"
              >
                <div>
                  {/* Video Thumbnail */}
                  <div className="aspect-video w-full bg-[#090B10] border-b border-slate-800/80 relative overflow-hidden flex items-center justify-center">
                    <img
                      src={`/api/media/thumbnail/${job.id}`}
                      alt={job.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none" />
                    <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs font-mono tabular-nums text-white">
                      <span>{meta?.resolution || job.quality}</span>
                      <span>{meta?.durationFormatted || '00:00'}</span>
                    </div>
                  </div>

                  {/* Metadata Body */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span className="font-mono text-[#3985FF]">#{job.id}</span>
                      <span>{job.extractor}</span>
                    </div>

                    <h3 className="text-sm font-semibold text-white line-clamp-2">
                      {job.title}
                    </h3>

                    {meta ? (
                      <div className="grid grid-cols-2 gap-2 pt-1 text-xs font-mono tabular-nums text-slate-300">
                        <div className="p-2 rounded bg-[#090B10] border border-slate-800/70">
                          <div className="text-[10px] text-slate-500">DIMENSIONS</div>
                          <div>
                            {meta.width}×{meta.height} ({meta.fps}fps)
                          </div>
                        </div>
                        <div className="p-2 rounded bg-[#090B10] border border-slate-800/70">
                          <div className="text-[10px] text-slate-500">CODECS</div>
                          <div>
                            {meta.videoCodec} / {meta.audioCodec}
                          </div>
                        </div>
                        <div className="p-2 rounded bg-[#090B10] border border-slate-800/70">
                          <div className="text-[10px] text-slate-500">BITRATE</div>
                          <div>{meta.bitrateFormatted}</div>
                        </div>
                        <div className="p-2 rounded bg-[#090B10] border border-slate-800/70">
                          <div className="text-[10px] text-slate-500">FILE SIZE</div>
                          <div>{meta.fileSizeFormatted}</div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">Metadata pending extraction</p>
                    )}
                  </div>
                </div>

                {/* Footer Status */}
                <div className="px-4 py-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                  {job.status === 'completed' ? (
                    <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Uploaded ({job.destinationName})
                    </span>
                  ) : (
                    <span className="text-rose-400 font-medium flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Upload Failed (Retained)
                    </span>
                  )}

                  {job.status === 'failed' && (
                    <button
                      onClick={() => onRetryJob(job.id)}
                      className="text-[#3985FF] hover:underline font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Retry
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface UploadHistoryProps {
  history: UploadHistoryRecord[];
  onRetryJob: (jobId: string) => Promise<void>;
}

export const UploadHistoryView: React.FC<UploadHistoryProps> = ({ history, onRetryJob }) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed'>('all');

  const filtered = history.filter((h) => {
    if (statusFilter === 'all') return true;
    return h.status === statusFilter;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#131722] border border-slate-800/90 rounded-xl p-5">
        <div>
          <h2 className="text-base font-display font-semibold text-white">
            Telegram Upload History
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Complete audit log of Wzgram MTProto deliveries to channels and private chats
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#090B10] border border-slate-800 rounded-lg">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              statusFilter === 'all' ? 'bg-[#3985FF] text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            All ({history.length})
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              statusFilter === 'completed'
                ? 'bg-[#3985FF] text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Completed
          </button>
          <button
            onClick={() => setStatusFilter('failed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              statusFilter === 'failed'
                ? 'bg-[#3985FF] text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Failed
          </button>
        </div>
      </div>

      <div className="bg-[#131722] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 text-[11px] font-medium text-slate-400">
                <th className="py-3.5 px-6">Video & Source</th>
                <th className="py-3.5 px-4">Destination Channel / Chat</th>
                <th className="py-3.5 px-4">Stream Specs</th>
                <th className="py-3.5 px-4">Timestamp</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-6 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {filtered.map((item) => (
                <tr key={item.id} className="hover:bg-slate-800/25 transition-colors">
                  <td className="py-3.5 px-6 max-w-xs">
                    <div className="font-medium text-white truncate">{item.title}</div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">
                      Job #{item.jobId} · {item.url}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-slate-300">
                    <div className="font-medium">{item.destinationName}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {item.destinationChatId}
                      {item.telegramMessageId ? ` · Msg #${item.telegramMessageId}` : ''}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-slate-300">
                    {item.resolution} <span aria-hidden="true">·</span> {item.durationFormatted}{' '}
                    <span aria-hidden="true">·</span> {item.fileSizeFormatted}
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    {item.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Delivered
                      </span>
                    ) : (
                      <div>
                        <span className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Failed
                        </span>
                        {item.errorMessage && (
                          <div className="text-[11px] text-rose-300/80 truncate max-w-[200px]">
                            {item.errorMessage}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-3.5 px-6 text-right">
                    {item.status === 'failed' && (
                      <button
                        onClick={() => onRetryJob(item.jobId)}
                        className="px-3 py-1.5 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] text-white text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Retry Upload
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
