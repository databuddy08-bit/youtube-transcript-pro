// YouTube Transcript Pro — Apify actor entry point.
import { Actor, log } from 'apify';
import { Client, Session, BlockedError, StoppedError } from './http.js';
import { makeYouTube, parseYouTubeInput, chooseTrack, watchUrl } from './youtube.js';
import { toText, toSrt, toVtt, toTimestamped, wordCount, paragraphs, chunks, chapters, keywordHits } from './format.js';
import { translateLines } from './translate.js';
import { transcribe, pickAudio, MAX_AUDIO_BYTES } from './ai.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_TRANSCRIPT = 'transcript'; // transcript from YouTube captions
export const EVENT_AI = 'ai-transcript'; // transcript made by AI from the audio (user's own API key)

const CONCURRENCY = 15;
const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 50;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(typeof x === 'object' && x ? x.url ?? '' : x).trim()).filter(Boolean);
const opts = {
    urls: list(input.urls),
    searchQueries: list(input.searchQueries),
    maxVideosPerSource: num(input.maxVideosPerSource, 20, 1, 5000),
    channelTab: ['videos', 'shorts', 'streams'].includes(input.channelTab) ? input.channelTab : 'videos',
    languages: list(input.languages).length ? list(input.languages) : ['en'],
    fallbackToAnyLanguage: input.fallbackToAnyLanguage !== false,
    preferManualCaptions: input.preferManualCaptions !== false,
    allLanguages: Boolean(input.allLanguages),
    translateTo: String(input.translateTo ?? '').trim(),
    includeSrt: input.includeSrt !== false,
    includeVtt: input.includeVtt !== false,
    includeSegments: input.includeSegments !== false,
    includeTimestampedText: Boolean(input.includeTimestampedText),
    includeParagraphs: Boolean(input.includeParagraphs),
    chunkWords: num(input.chunkWords, 0, 0, 5000),
    chunkOverlapWords: num(input.chunkOverlapWords, 0, 0, 1000),
    includeChapters: input.includeChapters !== false,
    transcriptKeywords: list(input.transcriptKeywords),
    extraMetadata: input.extraMetadata !== false,
    publishedAfter: String(input.publishedAfter ?? '').trim(),
    minDurationSeconds: num(input.minDurationSeconds, 0, 0, 1e7),
    maxDurationSeconds: num(input.maxDurationSeconds, 0, 0, 1e7),
    skipShorts: Boolean(input.skipShorts),
    aiProvider: ['openai', 'groq'].includes(input.aiProvider) ? input.aiProvider : 'none',
    aiApiKey: String(input.aiApiKey ?? '').trim(),
    aiMaxMinutes: num(input.aiMaxMinutes, 60, 1, 600),
    maxResults: num(input.maxResults, 0, 0, 1e9),
    includeFailedVideos: input.includeFailedVideos !== false,
    skipPreviouslyScraped: Boolean(input.skipPreviouslyScraped),
    dedupeStoreName: /^[a-z0-9-]{1,63}$/.test(input.dedupeStoreName ?? '') ? input.dedupeStoreName : 'youtube-transcript-pro-seen',
};
if (opts.aiProvider !== 'none' && !opts.aiApiKey) {
    log.warning(`AI transcription is set to "${opts.aiProvider}" but no API key was given — AI fallback is off for this run.`);
    opts.aiProvider = 'none';
}
let publishedAfter = null;
if (opts.publishedAfter) {
    const rel = opts.publishedAfter.match(/^(\d+)\s*(day|week|month|year)s?$/i);
    publishedAfter = rel ? new Date(Date.now() - Number(rel[1]) * { day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2].toLowerCase()]) : new Date(opts.publishedAfter);
    if (Number.isNaN(publishedAfter.getTime())) await Actor.fail(`"${opts.publishedAfter}" is not a valid date. Use "2025-01-31" or "30 days".`);
}

// ---------- Deadline, routes, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
} catch (err) {
    log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
}
const groups = input.proxyConfiguration?.apifyProxyGroups ?? [];
const proxyLabel = !proxyConfiguration ? 'no proxy (server IP)' : input.proxyConfiguration?.useApifyProxy ? `Apify proxy (${groups.length ? groups.join(', ') : 'datacenter'})` : 'custom proxy';
const routes = [{ label: proxyLabel, proxy: proxyConfiguration }];
if (input.proxyFallback !== false) {
    const apifyProxyUsable = Actor.isAtHome() || Boolean(process.env.APIFY_PROXY_PASSWORD);
    if (apifyProxyUsable) {
        for (const g of [['RESIDENTIAL'], []]) {
            const label = `Apify proxy (${g.length ? g[0] : 'datacenter'})`;
            if (label === proxyLabel) continue;
            try {
                const pc = await Actor.createProxyConfiguration({ useApifyProxy: true, ...(g.length ? { apifyProxyGroups: g } : {}) });
                if (pc) routes.push({ label, proxy: pc });
            } catch { /* group not available on this account */ }
        }
    }
    if (proxyConfiguration) routes.push({ label: 'no proxy (server IP)', proxy: undefined });
}
log.info(`Network routes: ${routes.map((r) => r.label).join(' → ')}`);
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();

const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
    videosFound: 0, videosProcessed: 0, saved: 0, savedFromCaptions: 0, savedFromAi: 0, failedRowsSaved: 0,
    chargedEvents: { [EVENT_TRANSCRIPT]: 0, [EVENT_AI]: 0 }, statusCounts: {}, skipReasons: {}, sources: [],
    captionKinds: { manual: 0, auto: 0 }, languages: {}, translation: {}, requests: { requests: 0, blocked: 0, networkErrors: 0 }, routes: [],
};
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const client = new Client({ routes, msLeft, stats: summary.requests });
const yt = makeYouTube(client);

let seenStore = null;
let seenPrev = new Set();
if (opts.skipPreviouslyScraped) {
    seenStore = await Actor.openKeyValueStore(opts.dedupeStoreName);
    seenPrev = new Set((await seenStore.getValue('SEEN_VIDEOS')) ?? []);
    log.info(`Skip previous runs: ${seenPrev.size} videos remembered in "${opts.dedupeStoreName}".`);
}

// ---------- Output ----------
let chain = Promise.resolve();
const FIX = {
    invalid_input: 'Use a YouTube video, Shorts, channel (@handle or /channel/UC…) or playlist URL, or an 11-character video ID.',
    no_captions: opts.aiProvider === 'none'
        ? 'This video has no captions in any language. Turn on "AI transcription" with your OpenAI or Groq key to transcribe it from the audio.'
        : 'No captions, and AI transcription could not run for this video (see error).',
    no_matching_language: 'Captions exist, but not in your chosen languages. Add one of the available languages, or turn on "Fall back to any language".',
    unavailable: 'The video is private, deleted, blocked in the region YouTube served this request from, or restricted by its music label for apps (e.g. some official music videos).',
    age_restricted: 'YouTube requires sign-in for this video (age-restricted or members-only). Logged-out scraping cannot read it.',
    upcoming: 'The video is a scheduled premiere or live stream that hasn\'t happened yet.',
    blocked: `YouTube kept blocking requests on every route this run tried (${routes.map((r) => r.label).join(', ')}). Run again in a few minutes.`,
    not_found: 'Channel or playlist not found. Check the URL.',
    error: 'Unexpected error. Run again; if it repeats, send the run log to the developer.',
};
function saveFailed(base, status, error, fixHint) {
    bump(summary.statusCounts, status);
    if (!opts.includeFailedVideos) return chain;
    chain = chain.then(async () => {
        await Actor.pushData({ status, ...base, error, fix_hint: fixHint ?? FIX[status] ?? FIX.error, scraped_at: new Date().toISOString() }); // never charged
        summary.failedRowsSaved += 1;
    });
    return chain;
}

function save(row, event) {
    const p = chain.then(async () => {
        if (stopReason) return false;
        if (opts.maxResults && summary.saved >= opts.maxResults) {
            stop('max_results_reached');
            return false;
        }
        if (pricing.isPayPerEvent && charging.calculateMaxEventChargeCountWithinLimit(event) <= 0) {
            stop('max_cost_per_run_reached');
            return false;
        }
        const res = await Actor.pushData(row, event);
        summary.saved += 1;
        summary.chargedEvents[event] += res?.chargedCount ?? 0;
        if (event === EVENT_AI) summary.savedFromAi += 1;
        else summary.savedFromCaptions += 1;
        bump(summary.statusCounts, 'ok');
        if (seenStore) seenPrev.add(`${row.video_id}:${row.language ?? ''}`);
        if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        if (opts.maxResults && summary.saved >= opts.maxResults) stop('max_results_reached');
        if (summary.saved % PROGRESS_EVERY === 0) {
            const min = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
            log.info(`Progress: ${summary.saved} transcripts saved, ${Math.round(summary.saved / min)}/min.`);
        }
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}

// ---------- Building one transcript row ----------
function buildRow(base, segs, extra) {
    const text = toText(segs);
    const row = {
        status: 'ok',
        ...base,
        ...extra,
        line_count: segs.length,
        word_count: wordCount(text),
        transcript: text,
    };
    if (opts.includeTimestampedText) row.transcript_timestamped = toTimestamped(segs);
    if (opts.includeSrt) row.srt = toSrt(segs);
    if (opts.includeVtt) row.vtt = toVtt(segs);
    if (opts.includeParagraphs) row.paragraphs = paragraphs(segs);
    if (opts.chunkWords) row.chunks = chunks(segs, base.video_id, opts.chunkWords, opts.chunkOverlapWords);
    if (opts.includeChapters) row.chapters = chapters(base.description, segs, base.video_id, base.duration_seconds);
    if (opts.transcriptKeywords.length) {
        row.keyword_matches = keywordHits(segs, opts.transcriptKeywords, base.video_id);
        row.keyword_match_count = row.keyword_matches.length;
    }
    if (opts.includeSegments) {
        row.lines = segs.map((s) => s.text);
        row.data = segs;
    }
    return row;
}

async function translate(track, segs, session) {
    const target = opts.translateTo;
    if (!target || track.languageCode.split('-')[0].toLowerCase() === target.split('-')[0].toLowerCase()) return null;
    if (track.isTranslatable) {
        try {
            const t = await yt.captions(track, session, { tlang: target });
            if (t.length) {
                bump(summary.translation, 'youtube');
                return { text: toText(t), segs: t, source: 'youtube (official caption translation)' };
            }
        } catch { /* fall back */ }
    }
    const lines = await translateLines(segs.map((s) => s.text), target, { stats: summary.requests });
    if (lines) {
        bump(summary.translation, 'google_translate');
        const t = segs.map((s, i) => ({ ...s, text: lines[i] }));
        return { text: toText(t), segs: t, source: 'google translate (line by line, timings kept)' };
    }
    bump(summary.translation, 'failed');
    return { text: null, segs: null, source: 'translation failed (both YouTube and Google Translate refused)' };
}

const isShort = (meta, item) => Boolean(item.is_short) || (meta.duration_seconds !== null && meta.duration_seconds <= 180 && meta.is_shorts_eligible === true);

async function processVideo(item) {
    const session = new Session();
    const id = item.video_id;
    const base = { url: watchUrl(id), video_id: id, title: item.title ?? null, source: item.source, input_value: item.input };
    let pl;
    try {
        const [player, meta] = await Promise.all([yt.player(id, session), opts.extraMetadata || publishedAfter || opts.skipShorts ? yt.webMeta(id, session) : null]);
        pl = player;
        Object.assign(base, pl.details, meta ?? {}, { player_client: pl.client });
        base.title = base.title ?? item.title ?? null;
        base.channel_url = base.channel_url ?? (base.channel_id ? `https://www.youtube.com/channel/${base.channel_id}` : null);
    } catch (err) {
        if (err instanceof StoppedError) return 'stopped';
        if (err instanceof BlockedError) return saveFailed(base, 'blocked', err.message);
        return saveFailed(base, 'error', err.message);
    }
    summary.videosProcessed += 1;
    base.is_short = isShort(base, item);

    // filters (filtered videos are never charged)
    const reason = (opts.skipShorts && base.is_short && 'filtered_short')
        || (opts.minDurationSeconds && base.duration_seconds !== null && base.duration_seconds < opts.minDurationSeconds && 'filtered_too_short')
        || (opts.maxDurationSeconds && base.duration_seconds !== null && base.duration_seconds > opts.maxDurationSeconds && 'filtered_too_long')
        || (publishedAfter && base.publish_date && new Date(base.publish_date) < publishedAfter && 'filtered_published_before_date');
    if (reason) {
        bump(summary.skipReasons, reason);
        return reason;
    }

    const tracks = pl.tracks;
    base.available_languages = [...new Set(tracks.map((t) => t.languageCode))];
    base.available_tracks = tracks.map((t) => ({ language: t.languageCode, name: t.name, is_auto_generated: t.isAuto }));

    if (pl.status !== 'OK' && !tracks.length) {
        const r = pl.reason ?? pl.status;
        if (pl.status === 'LOGIN_REQUIRED') return saveFailed(base, 'age_restricted', r);
        if (pl.status === 'LIVE_STREAM_OFFLINE') return saveFailed(base, 'upcoming', r);
        return saveFailed(base, 'unavailable', r);
    }

    // pick track(s)
    let picks = [];
    if (opts.allLanguages) picks = tracks.map((t) => ({ track: t, matchedPreferred: true }));
    else {
        const c = chooseTrack(tracks, opts.languages, { preferManual: opts.preferManualCaptions, fallbackToAny: opts.fallbackToAnyLanguage });
        if (c) picks = [c];
    }
    if (opts.allLanguages && !opts.preferManualCaptions) picks.sort((a, b) => Number(b.track.isAuto) - Number(a.track.isAuto));

    if (!picks.length && tracks.length) return saveFailed(base, 'no_matching_language', `captions available in: ${base.available_languages.join(', ')}`);
    if (!picks.length) return aiFallback(base, pl, session);

    for (const { track, matchedPreferred } of picks) {
        if (stopReason) return 'stopped';
        const key = `${id}:${track.languageCode}`;
        if (seenPrev.has(key)) {
            bump(summary.skipReasons, 'seen_in_previous_run');
            continue;
        }
        let segs;
        try {
            segs = await yt.captions(track, session);
        } catch (err) {
            if (err instanceof StoppedError) return 'stopped';
            await saveFailed({ ...base, language: track.languageCode }, err instanceof BlockedError ? 'blocked' : 'error', `caption download failed: ${err.message}`);
            continue;
        }
        if (!segs.length) {
            await saveFailed({ ...base, language: track.languageCode }, 'no_captions', 'the caption track is empty');
            continue;
        }
        bump(summary.captionKinds, track.isAuto ? 'auto' : 'manual');
        bump(summary.languages, track.languageCode);
        const extra = {
            transcript_source: 'youtube_captions',
            language: track.languageCode,
            language_name: track.name,
            is_auto_generated: track.isAuto,
            matched_preferred_language: matchedPreferred,
        };
        const tr = await translate(track, segs, session);
        if (tr) Object.assign(extra, { translated_to: opts.translateTo, transcript_translated: tr.text, translation_source: tr.source, ...(opts.includeSegments && tr.segs ? { data_translated: tr.segs } : {}) });
        await save(buildRow(base, segs, extra), EVENT_TRANSCRIPT);
    }
    return 'ok';
}

async function aiFallback(base, pl, session) {
    if (opts.aiProvider === 'none') return saveFailed(base, 'no_captions', 'this video has no captions');
    if (seenPrev.has(`${base.video_id}:ai`)) {
        bump(summary.skipReasons, 'seen_in_previous_run');
        return 'skipped';
    }
    if (base.duration_seconds && base.duration_seconds > opts.aiMaxMinutes * 60) {
        return saveFailed(base, 'no_captions', `no captions; video is ${Math.round(base.duration_seconds / 60)} min — above your AI limit of ${opts.aiMaxMinutes} min`);
    }
    const fmt = pickAudio(pl.audio);
    if (!fmt) return saveFailed(base, 'no_captions', 'no captions, and YouTube offered no downloadable audio for AI transcription');
    try {
        const audio = await yt.downloadAudio(fmt, session, MAX_AUDIO_BYTES);
        const r = await transcribe(opts.aiProvider, opts.aiApiKey, audio, fmt.mime, { language: opts.languages[0] });
        if (!r.segments.length) return saveFailed(base, 'no_captions', 'AI transcription returned no speech (music-only or silent video?)');
        bump(summary.languages, r.language ?? 'unknown');
        const extra = { transcript_source: 'ai', ai_model: r.model, language: r.language, language_name: r.language, is_auto_generated: true, matched_preferred_language: null };
        const tr = opts.translateTo ? await translate({ languageCode: r.language ?? 'auto', isTranslatable: false }, r.segments, session) : null;
        if (tr) Object.assign(extra, { translated_to: opts.translateTo, transcript_translated: tr.text, translation_source: tr.source });
        const row = buildRow(base, r.segments, extra);
        await save(row, EVENT_AI);
        if (seenStore) seenPrev.add(`${base.video_id}:ai`);
        return 'ok';
    } catch (err) {
        if (err instanceof StoppedError) return 'stopped';
        if (err.badKey) {
            log.error(`AI provider rejected the API key (${err.message}). Turning AI fallback off for the rest of the run.`);
            opts.aiProvider = 'none';
        }
        return saveFailed(base, 'no_captions', `no captions; AI transcription failed: ${err.message}`);
    }
}

// ---------- Collect videos from inputs ----------
const items = [];
const queued = new Set();
const enqueue = (video, source, inputValue) => {
    if (queued.has(video.video_id)) {
        bump(summary.skipReasons, 'duplicate_video');
        return false;
    }
    queued.add(video.video_id);
    items.push({ ...video, source, input: inputValue });
    return true;
};
const sources = [];
for (const raw of opts.urls) {
    const t = parseYouTubeInput(raw);
    if (!t) continue;
    if (t.invalid) {
        await saveFailed({ input_value: t.input }, 'invalid_input', t.error);
        continue;
    }
    if (t.kind === 'video') enqueue({ video_id: t.id }, 'video', t.input);
    else sources.push(t);
}
for (const q of opts.searchQueries) sources.push({ kind: 'search', id: q, input: q });

for (const src of sources) {
    if (stopReason) break;
    const session = new Session();
    const rec = { input: src.input, kind: src.kind, found: 0 };
    summary.sources.push(rec);
    try {
        if (src.kind === 'handle') {
            src.id = await yt.resolveChannel(src.id, session);
            src.kind = 'channel';
        }
        const label = src.kind === 'search' ? `search: ${src.id}` : `${src.kind}: ${src.input}`;
        for await (const v of yt.listVideos({ ...src, tab: src.tab ?? opts.channelTab }, session)) {
            if (opts.skipShorts && v.is_short) {
                bump(summary.skipReasons, 'filtered_short');
                continue;
            }
            if (enqueue(v, label, src.input)) rec.found += 1;
            if (rec.found >= opts.maxVideosPerSource || stopReason) break;
        }
        if (!rec.found) await saveFailed({ input_value: src.input }, 'no_results', `no videos found for this ${src.kind}`, 'Check the URL or search term. For channels, try another tab (videos / shorts / streams).');
    } catch (err) {
        if (err instanceof StoppedError) break;
        rec.error = err.message;
        await saveFailed({ input_value: src.input }, err.notFound ? 'not_found' : err instanceof BlockedError ? 'blocked' : 'error', err.message);
    }
}
summary.videosFound = items.length;
if (!items.length && !summary.failedRowsSaved) log.warning('Nothing to do: add YouTube URLs or search queries.');
log.info(`${items.length} videos queued from ${opts.urls.length} URL(s) and ${opts.searchQueries.length} search(es). Languages: ${opts.languages.join(', ')}${opts.translateTo ? ` → translate to ${opts.translateTo}` : ''}${opts.aiProvider !== 'none' ? ` · AI fallback: ${opts.aiProvider}` : ''}.`);

const queue = [...items];
if (queue.length && !stopReason) await processVideo(queue.shift()); // the first video runs alone so route problems are found before fan-out
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !stopReason && msLeft() > 0) {
        try {
            await processVideo(queue.shift());
        } catch (err) {
            log.exception(err, 'Unexpected error');
        }
    }
}));
await chain;

// ---------- Summary ----------
summary.stopReason = stopReason ?? 'completed';
summary.notProcessed = queue.length;
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.routes = client.routesSummary();
await Actor.setValue('RUN_SUMMARY', summary);
if (seenStore) await seenStore.setValue('SEEN_VIDEOS', [...seenPrev]);
const failed = summary.failedRowsSaved;
const msg = `Saved ${summary.saved} transcripts (${summary.savedFromCaptions} from captions${summary.savedFromAi ? `, ${summary.savedFromAi} by AI` : ''}) from ${summary.videosFound} videos. ${failed} without transcript (not charged). Stop reason: ${summary.stopReason}.`;
log.info(msg);
await Actor.exit({ statusMessage: msg });
