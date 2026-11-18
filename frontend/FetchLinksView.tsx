import React, { useState } from 'react';
import {
  Link2,
  Search,
  Copy,
  Check,
  Download,
  Send,
  Film,
  Globe,
  HardDrive,
  Clock,
  Sparkles,
  AlertCircle,
  ExternalLink,
  Layers,
  Radio,
  CheckSquare,
  Square,
  LayoutGrid,
  Zap,
} from 'lucide-react';
import {
  ChannelRecord,
  DiscoveredPostItem,
  ExtractedDirectLink,
  NavSection,
  PostFetchResult,
} from './types.ts';

interface FetchLinksViewProps {
  channels: ChannelRecord[];
  onStartJob: (payload: {
    url: string;
    title: string;
    extractor: string;
    quality: string;
    formatId: string;
    destinationId: string;
    customCaption: string;
    useAutoCaption: boolean;
    thumbnailTimestamp: string;
    thumbnailUrl?: string;
  }) => Promise<void>;
  onNavigate: (section: NavSection) => void;
}

export const FetchLinksView: React.FC<FetchLinksViewProps> = ({
  channels,
  onStartJob,
  onNavigate,
}) => {
  const defaultChannel = channels.find((c) => c.isDefault) || channels[0];

  const [postUrl, setPostUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [result, setResult] = useState<PostFetchResult | null>(null);
  const [destinationId, setDestinationId] = useState(defaultChannel?.id || '');
  const [batchQuality, setBatchQuality] = useState('1080p');

  // Selection state for discovered posts on a website/category page
  const [selectedPostIds, setSelectedPostIds] = useState<Record<string, boolean>>({});
  const [batchQueueing, setBatchQueueing] = useState(false);
  const [batchQueuedCount, setBatchQueuedCount] = useState<number | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedAllPosts, setCopiedAllPosts] = useState(false);
  const [queuingId, setQueuingId] = useState<string | null>(null);
  const [queuedIds, setQueuedIds] = useState<Record<string, boolean>>({});

  const handleFetchLinks = async (
    e?: React.FormEvent,
    overrideUrl?: string,
    fallbackThumbnail?: string
  ) => {
    if (e) e.preventDefault();
    const targetUrl = (overrideUrl ?? postUrl).trim();
    if (!targetUrl) return;

    setFetching(true);
    setFetchError(null);
    setBatchQueuedCount(null);

    try {
      const res = await fetch('/api/fetch-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data: PostFetchResult & { error?: string } = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to extract posts or direct links from URL');
      }
      if (!data.thumbnail && fallbackThumbnail) {
        data.thumbnail = fallbackThumbnail;
      }
      setResult(data);
      setQueuedIds({});

      // Default select first 5 discovered posts when crawling a website/listing page
      const initialSel: Record<string, boolean> = {};
      if (Array.isArray(data.discoveredPosts)) {
        data.discoveredPosts.slice(0, 5).forEach((p) => {
          initialSel[p.id] = true;
        });
      }
      setSelectedPostIds(initialSel);
    } catch (err: any) {
      setFetchError(err?.message || 'Unable to extract posts or direct download links from this URL');
    } finally {
      setFetching(false);
    }
  };

  const handleCopyLink = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyAllLinks = async () => {
    if (!result || result.directLinks.length === 0) return;
    try {
      const text = result.directLinks
        .map((l) => `${l.quality} (${l.filesizeFormatted}): ${l.directUrl}`)
        .join('\n');
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyAllPostUrls = async () => {
    if (!result || result.discoveredPosts.length === 0) return;
    try {
      const text = result.discoveredPosts.map((p) => p.postUrl).join('\n');
      await navigator.clipboard.writeText(text);
      setCopiedAllPosts(true);
      setTimeout(() => setCopiedAllPosts(false), 2000);
    } catch {
      // Ignore
    }
  };

  const togglePostSelection = (id: string) => {
    setSelectedPostIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const selectTopNPosts = (n: number) => {
    if (!result) return;
    const next: Record<string, boolean> = {};
    result.discoveredPosts.slice(0, n).forEach((p) => {
      next[p.id] = true;
    });
    setSelectedPostIds(next);
  };

  const toggleSelectAllPosts = () => {
    if (!result) return;
    const allSelected =
      result.discoveredPosts.length > 0 &&
      result.discoveredPosts.every((p) => selectedPostIds[p.id]);
    if (allSelected) {
      setSelectedPostIds({});
    } else {
      const next: Record<string, boolean> = {};
      result.discoveredPosts.forEach((p) => {
        next[p.id] = true;
      });
      setSelectedPostIds(next);
    }
  };

  const handleBatchDownloadAndUpload = async () => {
    if (!result) return;
    const selectedPosts = result.discoveredPosts.filter((p) => selectedPostIds[p.id]);
    if (selectedPosts.length === 0) return;

    setBatchQueueing(true);
    setFetchError(null);
    setBatchQueuedCount(null);

    try {
      const res = await fetch('/api/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posts: selectedPosts,
          quality: batchQuality,
          destinationId: destinationId || defaultChannel?.id || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to enqueue batch posts');
      }
      const nextQueued = { ...queuedIds };
      selectedPosts.forEach((p) => {
        nextQueued[p.id] = true;
      });
      setQueuedIds(nextQueued);
      setBatchQueuedCount(data.count || selectedPosts.length);
    } catch (err: any) {
      setFetchError(err?.message || 'Failed to enqueue selected posts');
    } finally {
      setBatchQueueing(false);
    }
  };

  const handleQueueSingleDiscoveredPost = async (post: DiscoveredPostItem) => {
    setQueuingId(post.id);
    setFetchError(null);

    try {
      await onStartJob({
        url: post.postUrl,
        title: post.title || 'Discovered Video Post',
        extractor: 'Post Crawler',
        quality: batchQuality || 'best',
        formatId: batchQuality || 'best',
        destinationId: destinationId || defaultChannel?.id || '',
        customCaption: '',
        useAutoCaption: true,
        thumbnailTimestamp: '00:00:02',
        thumbnailUrl: post.thumbnail || '',
      });
      setQueuedIds((prev) => ({ ...prev, [post.id]: true }));
    } catch (err: any) {
      setFetchError(err?.message || 'Failed to enqueue post');
    } finally {
      setQueuingId(null);
    }
  };

  const handleQueueDirectLink = async (link: ExtractedDirectLink) => {
    if (!result) return;
    setQueuingId(link.id);
    setFetchError(null);

    try {
      await onStartJob({
        url: link.directUrl,
        title: result.title || `Direct Video (${link.quality})`,
        extractor: `${result.extractor} Direct (${link.quality})`,
        quality: link.quality || 'best',
        formatId: 'best',
        destinationId: destinationId || defaultChannel?.id || '',
        customCaption: '',
        useAutoCaption: true,
        thumbnailTimestamp: '00:00:02',
        thumbnailUrl: result.thumbnail || '',
      });
      setQueuedIds((prev) => ({ ...prev, [link.id]: true }));
    } catch (err: any) {
      setFetchError(err?.message || 'Failed to enqueue direct download link');
    } finally {
      setQueuingId(null);
    }
  };

  const selectedPostsCount = result
    ? result.discoveredPosts.filter((p) => selectedPostIds[p.id]).length
    : 0;

  return (
    <div className="space-y-6">
      {/* Header & Website / Post URL Crawler Input */}
      <div className="bg-[#131722] border border-slate-800/80 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[#3985FF]/15 border border-[#3985FF]/30 flex items-center justify-center text-[#3985FF]">
                <Link2 className="w-4 h-4" />
              </div>
              <h1 className="font-display font-bold text-lg text-white">
                Website Post Crawler & Direct Link Extractor
              </h1>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Paste any <strong>Website / Category URL</strong> to automatically fetch all video post links from the page and batch download & upload them, or paste a <strong>Single Post URL</strong> to extract raw direct streams.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Quality:</span>
              <select
                value={batchQuality}
                onChange={(e) => setBatchQuality(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-[#0B0F19] border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-[#3985FF]"
              >
                <option value="best">Best (Auto)</option>
                <option value="2160p">4K (2160p)</option>
                <option value="1440p">2K (1440p)</option>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p HD</option>
                <option value="480p">480p SD</option>
                <option value="360p">360p Fast</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Radio className="w-3.5 h-3.5 text-[#3985FF]" />
              <span className="text-xs text-slate-400">Target Chat:</span>
              <select
                value={destinationId || defaultChannel?.id || ''}
                onChange={(e) => setDestinationId(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-[#0B0F19] border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-[#3985FF]"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.chatId})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <form onSubmit={(e) => handleFetchLinks(e)} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Globe className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="url"
                required
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
                placeholder="Paste Website/Category URL (e.g., https://www.eporner.com/) or Single Video Post URL"
                className="w-full pl-10 pr-4 py-3 rounded-lg bg-[#0B0F19] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#3985FF] font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={fetching}
              className="px-6 py-3 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
            >
              <Search className="w-4 h-4" />
              {fetching ? 'Scanning Page...' : 'Fetch Page Posts & Links'}
            </button>
          </div>

          {/* Quick fill sample buttons */}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span>Quick test:</span>
            <button
              type="button"
              onClick={() => {
                const sample = 'https://www.eporner.com/';
                setPostUrl(sample);
                handleFetchLinks(undefined, sample);
              }}
              className="px-2.5 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800/80 border border-slate-800 text-slate-300 font-mono transition-colors cursor-pointer"
            >
              🌐 Website: eporner.com (Fetch All Posts)
            </button>
            <button
              type="button"
              onClick={() => {
                const sample = 'https://www.eporner.com/video-CeH7wwgZKGL/tori/';
                setPostUrl(sample);
                handleFetchLinks(undefined, sample);
              }}
              className="px-2.5 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800/80 border border-slate-800 text-slate-300 font-mono transition-colors cursor-pointer"
            >
              🎬 Single Post: eporner.com/video-CeH7wwgZKGL/tori/
            </button>
          </div>
        </form>

        {fetchError && (
          <div className="mt-4 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{fetchError}</span>
          </div>
        )}

        {batchQueuedCount !== null && (
          <div className="mt-4 p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                Successfully queued <strong>{batchQueuedCount} video posts</strong> for automatic download & Telegram upload!
              </span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('active-jobs')}
              className="px-3 py-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 font-semibold transition-colors cursor-pointer shrink-0"
            >
              Open Active Queue →
            </button>
          </div>
        )}
      </div>

      {/* Loading Skeleton */}
      {fetching && (
        <div className="bg-[#131722] border border-slate-800/80 rounded-xl p-8 text-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-[#3985FF]/15 border border-[#3985FF]/30 flex items-center justify-center text-[#3985FF] mx-auto animate-pulse">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="text-sm font-semibold text-white">
            Crawling Website Page for Video Posts & Direct Media Streams...
          </div>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Scanning page DOM for video post cards, thumbnails, durations, and direct MP4/HLS download links.
          </p>
        </div>
      )}

      {/* Results Area */}
      {!fetching && result && (
        <div className="space-y-6">
          {/* Page Summary Banner */}
          <div className="bg-[#131722] border border-slate-800/80 rounded-xl p-5 flex flex-col md:flex-row gap-5 items-start md:items-center justify-between">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 min-w-0 flex-1">
              <div className="w-full sm:w-40 aspect-video rounded-lg bg-[#0B0F19] border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center relative">
                {result.thumbnail ? (
                  <img
                    src={result.thumbnail}
                    alt={result.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Film className="w-7 h-7 text-slate-600" />
                )}
                {result.durationFormatted && (
                  <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white">
                    {result.durationFormatted}
                  </span>
                )}
              </div>

              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-[#3985FF]/15 border border-[#3985FF]/30 text-[11px] font-mono font-semibold text-[#3985FF]">
                    {result.extractor}
                  </span>
                  {result.discoveredPosts.length > 0 && (
                    <span className="px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 text-[11px] font-mono font-semibold text-indigo-300">
                      {result.discoveredPosts.length} Video Posts Found on Page
                    </span>
                  )}
                  {result.directLinks.length > 0 && (
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-mono font-semibold text-emerald-400">
                      {result.directLinks.length} Direct Streams Found
                    </span>
                  )}
                </div>

                <h2 className="font-display font-bold text-base text-white truncate" title={result.title}>
                  {result.title}
                </h2>

                <div className="text-xs font-mono text-slate-400 truncate">
                  Source URL:{' '}
                  <a
                    href={result.postUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#3985FF] hover:underline"
                  >
                    {result.postUrl}
                  </a>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0 w-full md:w-auto justify-end">
              <button
                type="button"
                onClick={() => onNavigate('active-jobs')}
                className="px-3.5 py-2 rounded-lg bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Layers className="w-3.5 h-3.5 text-[#3985FF]" />
                <span>View Active Queue</span>
              </button>
            </div>
          </div>

          {/* SECTION 1: Direct Download Links (When Single Post or Hybrid) */}
          {result.directLinks.length > 0 && (
            <div className="bg-[#131722] border border-slate-800/80 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-[#3985FF]" />
                  <h3 className="font-display font-semibold text-sm text-white">
                    Extracted Direct Download Streams ({result.directLinks.length})
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={handleCopyAllLinks}
                  className="px-3 py-1.5 rounded-lg bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  {copiedAll ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied All Direct URLs</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-slate-400" />
                      <span>Copy All Direct URLs</span>
                    </>
                  )}
                </button>
              </div>

              <div className="divide-y divide-slate-800/80">
                {result.directLinks.map((link) => {
                  const isCopied = copiedId === link.id;
                  const isQueuedDirect = queuedIds[link.id];

                  return (
                    <div
                      key={link.id}
                      className="p-4 sm:p-5 hover:bg-[#0B0F19]/50 transition-colors flex flex-col gap-3"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="px-2.5 py-1 rounded-md bg-[#3985FF]/15 border border-[#3985FF]/40 text-xs font-mono font-bold text-[#3985FF]">
                            {link.quality}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-[11px] font-mono text-slate-200 uppercase">
                            {link.ext}
                          </span>
                          <span className="px-2.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono font-semibold text-emerald-400">
                            {link.filesizeFormatted}
                          </span>
                          <span className="text-[11px] font-mono text-slate-500">
                            {link.vcodec}
                            {link.hasAudio ? ` + ${link.acodec}` : ' (video only)'}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopyLink(link.id, link.directUrl)}
                            className="px-3 py-1.5 rounded-lg bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            {isCopied ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-400">Copied!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5 text-slate-400" />
                                <span>Copy Link</span>
                              </>
                            )}
                          </button>

                          <a
                            href={link.directUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded-lg bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5 text-[#3985FF]" />
                            <span>Direct Download</span>
                            <ExternalLink className="w-3 h-3 text-slate-500" />
                          </a>

                          <button
                            type="button"
                            disabled={queuingId === link.id || isQueuedDirect}
                            onClick={() => handleQueueDirectLink(link)}
                            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                              isQueuedDirect
                                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                                : 'bg-[#3985FF] hover:bg-[#2563EB] text-white'
                            }`}
                          >
                            {isQueuedDirect ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>Queued to Telegram</span>
                              </>
                            ) : (
                              <>
                                <Send className="w-3.5 h-3.5" />
                                <span>
                                  {queuingId === link.id
                                    ? 'Queueing...'
                                    : 'Download & Upload to Telegram'}
                                </span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 bg-[#0B0F19] border border-slate-800/90 rounded-lg px-3 py-2">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 shrink-0">
                          Direct URL
                        </span>
                        <input
                          type="text"
                          readOnly
                          value={link.directUrl}
                          onFocus={(e) => e.currentTarget.select()}
                          className="w-full bg-transparent text-xs font-mono text-slate-300 focus:outline-none select-all truncate"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 2: Discovered Video Posts on Website Page (Batch Crawl & Download) */}
          {result.discoveredPosts.length > 0 && (
            <div className="bg-[#131722] border border-slate-800/80 rounded-xl overflow-hidden">
              {/* Batch Action Toolbar */}
              <div className="px-5 py-4 border-b border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-[#0B0F19]/40">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="w-4 h-4 text-[#3985FF]" />
                    <h3 className="font-display font-semibold text-sm text-white">
                      {result.pageType === 'hybrid'
                        ? `Related Video Posts on Page (${result.discoveredPosts.length})`
                        : `Discovered Video Posts on Website Page (${result.discoveredPosts.length})`}
                    </h3>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={toggleSelectAllPosts}
                      className="px-2.5 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-slate-200 font-medium transition-colors cursor-pointer"
                    >
                      {selectedPostsCount === result.discoveredPosts.length
                        ? 'Deselect All'
                        : 'Select All'}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectTopNPosts(3)}
                      className="px-2 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 font-mono text-[11px] transition-colors cursor-pointer"
                    >
                      Top 3
                    </button>
                    <button
                      type="button"
                      onClick={() => selectTopNPosts(5)}
                      className="px-2 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 font-mono text-[11px] transition-colors cursor-pointer"
                    >
                      Top 5
                    </button>
                    <button
                      type="button"
                      onClick={() => selectTopNPosts(10)}
                      className="px-2 py-1 rounded-md bg-[#0B0F19] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 font-mono text-[11px] transition-colors cursor-pointer"
                    >
                      Top 10
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleCopyAllPostUrls}
                    className="px-3 py-2 rounded-lg bg-[#0B0F19] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    {copiedAllPosts ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied {result.discoveredPosts.length} Post URLs</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-slate-400" />
                        <span>Copy All Post Links</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={selectedPostsCount === 0 || batchQueueing}
                    onClick={handleBatchDownloadAndUpload}
                    className="px-4 py-2 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer shadow-sm"
                  >
                    <Zap className="w-3.5 h-3.5 fill-current" />
                    <span>
                      {batchQueueing
                        ? `Queueing ${selectedPostsCount} Posts...`
                        : `Download & Upload Selected (${selectedPostsCount}) to Telegram`}
                    </span>
                  </button>
                </div>
              </div>

              {/* Discovered Posts Grid */}
              <div className="p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {result.discoveredPosts.map((post, idx) => {
                  const isSelected = Boolean(selectedPostIds[post.id]);
                  const isQueued = Boolean(queuedIds[post.id]);
                  const isCopied = copiedId === post.id;

                  return (
                    <div
                      key={post.id}
                      className={`rounded-xl border transition-all flex flex-col justify-between overflow-hidden ${
                        isSelected
                          ? 'bg-[#0B0F19] border-[#3985FF]/60'
                          : 'bg-[#0B0F19]/60 border-slate-800/80 hover:border-slate-700'
                      }`}
                    >
                      <div>
                        {/* Thumbnail Header */}
                        <div
                          onClick={() => togglePostSelection(post.id)}
                          className="relative aspect-video bg-slate-900 border-b border-slate-800/80 overflow-hidden cursor-pointer group"
                        >
                          {post.thumbnail ? (
                            <img
                              src={post.thumbnail}
                              alt={post.title}
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-600">
                              <Film className="w-8 h-8" />
                            </div>
                          )}

                          {/* Top-left selection checkbox badge */}
                          <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/80 backdrop-blur-xs text-xs font-mono text-white">
                            {isSelected ? (
                              <CheckSquare className="w-3.5 h-3.5 text-[#3985FF]" />
                            ) : (
                              <Square className="w-3.5 h-3.5 text-slate-400" />
                            )}
                            <span>#{idx + 1}</span>
                          </div>

                          {/* Top-right quality badge */}
                          {post.qualityHint && (
                            <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-[#3985FF]/90 text-[10px] font-mono font-bold text-white">
                              {post.qualityHint}
                            </span>
                          )}

                          {/* Bottom-right duration badge */}
                          {post.duration && (
                            <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/85 text-[11px] font-mono text-slate-100 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5 text-slate-400" />
                              {post.duration}
                            </span>
                          )}
                        </div>

                        {/* Post Title & URL */}
                        <div className="p-3.5 space-y-1.5">
                          <h4
                            className="text-xs font-semibold text-slate-100 line-clamp-2 leading-snug"
                            title={post.title}
                          >
                            {post.title}
                          </h4>
                          <div className="text-[11px] font-mono text-slate-500 truncate" title={post.postUrl}>
                            {post.postUrl}
                          </div>
                        </div>
                      </div>

                      {/* Card Footer Actions */}
                      <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-800/60 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setPostUrl(post.postUrl);
                              handleFetchLinks(undefined, post.postUrl, post.thumbnail);
                            }}
                            title="Extract raw direct MP4 links from this post"
                            className="px-2.5 py-1.5 rounded-lg bg-[#131722] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <Link2 className="w-3 h-3 text-[#3985FF]" />
                            <span>Direct Links</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleCopyLink(post.id, post.postUrl)}
                            title="Copy Post URL"
                            className="p-1.5 rounded-lg bg-[#131722] hover:bg-slate-800 border border-slate-700 text-slate-300 transition-colors cursor-pointer"
                          >
                            {isCopied ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={queuingId === post.id || isQueued}
                          onClick={() => handleQueueSingleDiscoveredPost(post)}
                          className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                            isQueued
                              ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                              : 'bg-[#3985FF] hover:bg-[#2563EB] text-white'
                          }`}
                        >
                          {isQueued ? (
                            <>
                              <Check className="w-3 h-3" />
                              <span>Queued</span>
                            </>
                          ) : (
                            <>
                              <Send className="w-3 h-3" />
                              <span>
                                {queuingId === post.id ? 'Queueing...' : 'Download & Upload'}
                              </span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
