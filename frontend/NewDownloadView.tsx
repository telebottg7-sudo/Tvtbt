import React, { useState } from 'react';
import {
  Search,
  Play,
  Film,
  Image as ImageIcon,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Upload,
} from 'lucide-react';
import { ChannelRecord, VideoProbeInfo, AppConfig, NavSection } from './types.ts';

interface NewDownloadViewProps {
  channels: ChannelRecord[];
  settings: AppConfig;
  onStartJob: (payload: {
    url: string;
    title?: string;
    extractor?: string;
    quality: string;
    formatId: string;
    destinationId: string;
    customCaption: string;
    useAutoCaption: boolean;
    thumbnailTimestamp: string;
    thumbnailUrl?: string;
    customThumbnailBase64?: string;
  }) => Promise<void>;
  onNavigate: (section: NavSection) => void;
}

export const NewDownloadView: React.FC<NewDownloadViewProps> = ({
  channels,
  settings,
  onStartJob,
  onNavigate,
}) => {
  const [url, setUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeData, setProbeData] = useState<VideoProbeInfo | null>(null);

  const [selectedFormatId, setSelectedFormatId] = useState('best');
  const [selectedQualityLabel, setSelectedQualityLabel] = useState('Best Available');
  const [destinationId, setDestinationId] = useState(
    channels.find((c) => c.isDefault)?.id || channels[0]?.id || ''
  );
  const [useAutoCaption, setUseAutoCaption] = useState(true);
  const [customCaption, setCustomCaption] = useState('');
  const [thumbnailTimestamp, setThumbnailTimestamp] = useState(
    settings.thumbnailTimestamp || '00:00:02'
  );
  const [customThumbPreview, setCustomThumbPreview] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const handleProbeUrl = async (targetUrl?: string) => {
    const u = (targetUrl ?? url).trim();
    if (!u) return;
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to inspect stream');
      }
      setProbeData(data);
      if (data.formats && data.formats.length > 0) {
        setSelectedFormatId(data.formats[0].formatId);
        setSelectedQualityLabel(data.formats[0].resolution || 'Best');
      }
    } catch (err: any) {
      setProbeError(err?.message || 'Unable to extract video info');
    } finally {
      setProbing(false);
    }
  };

  const handleThumbUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCustomThumbPreview(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    try {
      await onStartJob({
        url: url.trim(),
        title: probeData?.title,
        extractor: probeData?.extractor,
        quality: selectedQualityLabel,
        formatId: selectedFormatId,
        destinationId,
        customCaption,
        useAutoCaption,
        thumbnailTimestamp,
        thumbnailUrl: probeData?.thumbnail,
        customThumbnailBase64: customThumbPreview || undefined,
      });
      onNavigate('active-jobs');
    } catch (err: any) {
      setProbeError(err?.message || 'Failed to start job');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* URL Input & Stream Prober */}
      <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6">
        <h2 className="text-lg font-display font-semibold text-white">
          New Video Download & Telegram Upload
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Inspect any yt-dlp compatible website or direct video link, choose stream quality and destination channel, and customize FFmpeg thumbnail & caption metadata.
        </p>

        <div className="mt-4 flex flex-col sm:flex-row gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste video URL (YouTube, Vimeo, Dailymotion, X, or direct .mp4 / .mkv)..."
            className="flex-1 bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors"
          />
          <button
            type="button"
            onClick={() => handleProbeUrl()}
            disabled={probing || !url.trim()}
            className="px-5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Search className="w-4 h-4 text-[#3985FF]" />
            {probing ? 'Inspecting via yt-dlp...' : 'Inspect Stream'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>Sample test streams:</span>
          <button
            type="button"
            onClick={() => {
              const sample =
                'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
              setUrl(sample);
              handleProbeUrl(sample);
            }}
            className="text-[#3985FF] hover:underline cursor-pointer"
          >
            Chromecast 1080p Blazes (.mp4)
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => {
              const sample =
                'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoy.mp4';
              setUrl(sample);
              handleProbeUrl(sample);
            }}
            className="text-[#3985FF] hover:underline cursor-pointer"
          >
            Chromecast 720p Joy (.mp4)
          </button>
        </div>

        {probeError && (
          <div className="mt-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{probeError}</span>
          </div>
        )}
      </div>

      {/* Video Information Preview + Configuration Form */}
      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Stream Quality, Destination, Caption */}
        <div className="lg:col-span-2 bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-5">
          {probeData && (
            <div className="p-4 rounded-lg bg-[#090B10] border border-slate-800/90 flex flex-col sm:flex-row gap-4 items-start">
              <div className="w-full sm:w-40 h-24 rounded-md bg-slate-900 border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center">
                {probeData.thumbnail ? (
                  <img
                    src={probeData.thumbnail}
                    alt={probeData.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Film className="w-6 h-6 text-[#3985FF]" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Stream Verified ({probeData.extractor})</span>
                </div>
                <h3 className="text-sm font-semibold text-white mt-1 line-clamp-2">
                  {probeData.title}
                </h3>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
                  <span>Uploader: {probeData.uploader}</span>
                  <span aria-hidden="true">·</span>
                  <span>Duration: {probeData.durationFormatted}</span>
                  <span aria-hidden="true">·</span>
                  <span>{probeData.formats.length} stream profiles</span>
                </div>
              </div>
            </div>
          )}

          {/* Available Quality Selection */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Available Stream Quality & Format (yt-dlp + aria2c)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {(probeData?.formats || [
                {
                  formatId: 'best',
                  label: 'Best Available Quality (Auto Merge Video + Audio)',
                  resolution: 'Best',
                  ext: 'mp4',
                  filesize: 0,
                  filesizeFormatted: 'Auto',
                  vcodec: 'H264',
                  acodec: 'AAC',
                  fps: 30,
                },
                {
                  formatId: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
                  label: '1080p Full HD (MP4)',
                  resolution: '1080p',
                  ext: 'mp4',
                  filesize: 0,
                  filesizeFormatted: 'Stream',
                  vcodec: 'H264',
                  acodec: 'AAC',
                  fps: 30,
                },
                {
                  formatId: 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
                  label: '720p HD (MP4)',
                  resolution: '720p',
                  ext: 'mp4',
                  filesize: 0,
                  filesizeFormatted: 'Stream',
                  vcodec: 'H264',
                  acodec: 'AAC',
                  fps: 30,
                },
                {
                  formatId: 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
                  label: '480p SD (Compact)',
                  resolution: '480p',
                  ext: 'mp4',
                  filesize: 0,
                  filesizeFormatted: 'Stream',
                  vcodec: 'H264',
                  acodec: 'AAC',
                  fps: 30,
                },
              ]).map((fmt) => {
                const active = selectedFormatId === fmt.formatId;
                return (
                  <button
                    key={fmt.formatId}
                    type="button"
                    onClick={() => {
                      setSelectedFormatId(fmt.formatId);
                      setSelectedQualityLabel(fmt.resolution);
                    }}
                    className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#3985FF]/15 border-[#3985FF] text-white'
                        : 'bg-[#090B10] border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-semibold">
                      <span className="truncate">{fmt.label}</span>
                      <span className="font-mono text-[11px] text-[#3985FF] ml-2 shrink-0">
                        {fmt.filesizeFormatted}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400 font-mono">
                      {fmt.vcodec} / {fmt.acodec} · {fmt.fps}fps
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Destination Selection */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Telegram Upload Destination (Wzgram MTProto)
            </label>
            <select
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2.5 text-sm text-white outline-none"
            >
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name} — {ch.chatId} ({ch.type.toUpperCase()})
                  {ch.isDefault ? ' [Default]' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Caption Customization */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-[#3985FF]" />
                Telegram Video Caption
              </label>
              <button
                type="button"
                onClick={() => setUseAutoCaption(!useAutoCaption)}
                className="text-xs text-[#3985FF] hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {useAutoCaption ? 'Using Automatic FFprobe Metadata Template' : 'Using Custom Caption'}
              </button>
            </div>

            <textarea
              rows={3}
              value={customCaption}
              onChange={(e) => {
                setCustomCaption(e.target.value);
                if (e.target.value.trim().length > 0) setUseAutoCaption(false);
              }}
              placeholder="Leave blank to automatically generate caption from FFprobe metadata (Title, Resolution, Codec, Duration, Size)..."
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg p-3 text-xs text-slate-200 placeholder-slate-500 outline-none font-mono"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting || !url.trim()}
              className="w-full py-3 px-5 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              {submitting ? 'Starting Download & Upload Pipeline...' : 'Start Download & Telegram Upload'}
            </button>
          </div>
        </div>

        {/* Right Column: Thumbnail Preview & FFmpeg Timestamp Settings */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-5 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold text-white">
                Thumbnail Configuration
              </h3>
              <ImageIcon className="w-4 h-4 text-[#3985FF]" />
            </div>

            <div className="aspect-video w-full rounded-lg bg-[#090B10] border border-slate-800 overflow-hidden flex items-center justify-center relative">
              {customThumbPreview || probeData?.thumbnail ? (
                <img
                  src={customThumbPreview || probeData?.thumbnail}
                  alt="Thumbnail preview"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center p-4">
                  <Film className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs text-slate-400">
                    FFmpeg will auto-extract JPEG frame at <span className="font-mono text-slate-200">{thumbnailTimestamp}</span> without re-encoding video
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                FFmpeg Thumbnail Capture Timestamp (HH:MM:SS)
              </label>
              <input
                type="text"
                value={thumbnailTimestamp}
                onChange={(e) => setThumbnailTimestamp(e.target.value)}
                placeholder="00:00:02"
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3 py-2 text-xs font-mono text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                Custom Telegram Thumbnail Override (Optional JPEG/PNG)
              </label>
              <label className="w-full py-2.5 px-3 rounded-lg bg-[#090B10] border border-dashed border-slate-700 hover:border-[#3985FF] text-xs text-slate-300 flex items-center justify-center gap-2 cursor-pointer transition-colors">
                <Upload className="w-3.5 h-3.5 text-[#3985FF]" />
                <span>{customThumbPreview ? 'Replace Custom Thumbnail' : 'Upload Custom Image'}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleThumbUpload}
                  className="hidden"
                />
              </label>
              {customThumbPreview && (
                <button
                  type="button"
                  onClick={() => setCustomThumbPreview('')}
                  className="mt-1.5 text-[11px] text-rose-400 hover:underline cursor-pointer"
                >
                  Clear custom thumbnail (use FFmpeg auto-extraction)
                </button>
              )}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-[#090B10] border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
            <div className="font-semibold text-slate-300">Pipeline Guarantee</div>
            <p>
              FFmpeg uses fast input seeking (<code className="text-slate-200">-ss</code> before <code className="text-slate-200">-i</code>) so the original video is never re-encoded.
            </p>
          </div>
        </div>
      </form>
    </div>
  );
};
