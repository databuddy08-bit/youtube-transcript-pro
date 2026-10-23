// YouTube: input parsing, InnerTube player/metadata/listing calls, caption download and parsing.
import { BlockedError, StoppedError } from './http.js';

const YT = process.env.YT_BASE ?? 'https://www.youtube.com';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// App clients, tried in this order. Verified Oct 2026: with a visitor ID from the same IP, IOS and ANDROID get past the
// "confirm you're not a bot" check that blocks ANDROID_VR and WEB playback from datacenter and residential IPs.
const APP_CLIENTS = [
    { name: 'ios', client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' },
    { name: 'android', client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' }, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
    { name: 'android_vr', client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' }, ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip' },
];
const WEB_CLIENT = { clientName: 'WEB', clientVersion: '2.20261022.01.00', hl: 'en', gl: 'US' };
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEB_HEADERS = { 'user-agent': WEB_UA, origin: 'https://www.youtube.com' };

// ---------- Input parsing ----------

/**
 * @returns {{kind:'video'|'channel'|'playlist'|'handle', id:string, input:string, tab?:string} | {invalid:true, input:string, error:string}}
 */
export function parseYouTubeInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return null;
    if (ID_RE.test(input)) return { kind: 'video', id: input, input };
    if (/^@[\w.-]{2,100}$/.test(input)) return { kind: 'handle', id: input, input };
    if (/^UC[\w-]{22}$/.test(input)) return { kind: 'channel', id: input, input };
    if (/^(PL|UU|OL|FL|RD|LL)[\w-]{10,}$/.test(input)) return { kind: 'playlist', id: input, input };
    let u;
    try {
        u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return { invalid: true, input, error: 'not a YouTube URL, video ID, @handle or channel/playlist ID' };
    }
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const seg = u.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be' && ID_RE.test(seg[0] ?? '')) return { kind: 'video', id: seg[0], input };
    if (!/^(youtube\.com|youtube-nocookie\.com)$/.test(host)) return { invalid: true, input, error: 'not a youtube.com / youtu.be URL' };
    const v = u.searchParams.get('v');
    if (seg[0] === 'watch' && ID_RE.test(v ?? '')) return { kind: 'video', id: v, input };
    if (['shorts', 'embed', 'live', 'v', 'e'].includes(seg[0]) && ID_RE.test(seg[1] ?? '')) return { kind: 'video', id: seg[1], input };
    const list = u.searchParams.get('list');
    if ((seg[0] === 'playlist' || seg[0] === 'watch') && list) return { kind: 'playlist', id: list, input };
    const tabOf = (s) => (['shorts', 'streams', 'videos'].includes(s) ? s : undefined);
    if (seg[0]?.startsWith('@')) return { kind: 'handle', id: seg[0], input, tab: tabOf(seg[1]) };
    if (seg[0] === 'channel' && /^UC[\w-]{22}$/.test(seg[1] ?? '')) return { kind: 'channel', id: seg[1], input, tab: tabOf(seg[2]) };
    if ((seg[0] === 'c' || seg[0] === 'user') && seg[1]) return { kind: 'handle', id: `${seg[0]}/${seg[1]}`, input, tab: tabOf(seg[2]) };
    return { invalid: true, input, error: 'unsupported YouTube URL — use a video, Shorts, channel, @handle or playlist URL' };
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------- InnerTube ----------

export function makeYouTube(client) {
    /** Visitor ID for the session's current IP (≈2 KB). Rotating the session (new IP) clears it. */
    async function visitor(session) {
        if (session.visitorData) return session.visitorData;
        try {
            const r = await client.fetch({ url: `${YT}/sw.js_data`, headers: { 'user-agent': WEB_UA }, attempts: 2, soft: true }, session);
            session.visitorData = String(r.body).match(/"(Cg[\w%-]{18,})"/)?.[1] ?? null;
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            session.visitorData = null;
        }
        return session.visitorData;
    }

    const innertube = (endpoint, payload, session, { app = null, soft = false, attempts } = {}) => client.fetch({
        url: `${YT}/youtubei/v1/${endpoint}?prettyPrint=false`,
        json: { ...payload, context: { client: app ? { hl: 'en', gl: 'US', ...app.client } : WEB_CLIENT } },
        headers: { 'user-agent': app ? app.ua : WEB_UA, ...(app ? {} : { origin: WEB_HEADERS.origin }), 'content-type': 'application/json' },
        prepare: async (s) => {
            const vd = await visitor(s);
            if (!vd) return {};
            const ctxClient = app ? { hl: 'en', gl: 'US', ...app.client, visitorData: vd } : { ...WEB_CLIENT, visitorData: vd };
            return { json: { ...payload, context: { client: ctxClient } }, headers: { 'x-goog-visitor-id': vd } };
        },
        allow403: false,
        soft,
        attempts,
        isBlocked: (res) => {
            if (typeof res.body !== 'string' || !res.body.startsWith('{')) return null;
            const reason = res.body.match(/"playabilityStatus":\{"status":"LOGIN_REQUIRED","reason":"([^"]+)"/)?.[1];
            return reason && /bot/i.test(reason) ? `YouTube bot check: "${reason}"` : null;
        },
    }, session).then((r) => {
        let json;
        try {
            json = JSON.parse(r.body);
        } catch {
            throw new BlockedError(`${endpoint}: response was not JSON (HTTP ${r.status})`);
        }
        if (json.error) throw Object.assign(new Error(`${endpoint}: ${json.error.message}`), { apiError: true, status: r.status });
        return json;
    });

    const shape = (j, videoId, app) => {
        const ps = j.playabilityStatus ?? {};
        const d = j.videoDetails ?? {};
        return {
            status: ps.status ?? 'UNKNOWN',
            reason: ps.reason ?? ps.messages?.[0] ?? null,
            client: app.name,
            hasDetails: Boolean(d.videoId),
            details: {
                video_id: d.videoId ?? videoId,
                title: d.title ?? null,
                channel: d.author ?? null,
                channel_id: d.channelId ?? null,
                duration_seconds: d.lengthSeconds ? Number(d.lengthSeconds) : null,
                view_count: d.viewCount ? Number(d.viewCount) : null,
                description: d.shortDescription ?? null,
                tags: d.keywords ?? [],
                is_live_content: Boolean(d.isLiveContent),
                thumbnail: d.thumbnail?.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
            },
            tracks: (j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({
                languageCode: t.languageCode,
                name: t.name?.simpleText ?? t.name?.runs?.map((x) => x.text).join('') ?? t.languageCode,
                isAuto: t.kind === 'asr',
                isTranslatable: t.isTranslatable !== false,
                baseUrl: t.baseUrl?.startsWith('http') ? t.baseUrl : `${YT}${t.baseUrl}`,
                ua: app.ua,
            })),
            audio: (j.streamingData?.adaptiveFormats ?? []).filter((f) => f.mimeType?.startsWith('audio/') && f.url)
                .map((f) => ({ itag: f.itag, mime: f.mimeType, bitrate: f.bitrate, bytes: f.contentLength ? Number(f.contentLength) : null, url: f.url, ua: app.ua })),
        };
    };

    /**
     * Player data (details, caption tracks, audio). Tries the app clients in order: the next one is used when a client is
     * bot-checked or refuses the video. Returns the first playable answer, else the most informative refusal.
     */
    async function player(videoId, session) {
        let best = null;
        let lastErr = null;
        for (const app of APP_CLIENTS) {
            let j;
            try {
                j = await innertube('player', { videoId, contentCheckOk: true, racyCheckOk: true }, session, { app, attempts: client.route.proxy ? 3 : 2 });
            } catch (err) {
                if (!(err instanceof BlockedError)) throw err;
                lastErr = err;
                continue;
            }
            const r = shape(j, videoId, app);
            if (r.status === 'OK' || r.tracks.length) return r;
            if (!best || (!best.hasDetails && r.hasDetails)) best = r;
        }
        if (best) return best;
        throw lastErr ?? new BlockedError('every player client was refused');
    }

    /** Extra metadata from the WEB player's microformat (works even when WEB playback is refused). Never throws. */
    async function webMeta(videoId, session) {
        try {
            const j = await innertube('player', { videoId }, session, { soft: true }); // optional: never retried, never hurts the route
            const m = j.microformat?.playerMicroformatRenderer;
            if (!m) return null;
            return {
                category: m.category ?? null,
                publish_date: m.publishDate ?? m.uploadDate ?? null,
                like_count: m.likeCount ? Number(m.likeCount) : null,
                is_family_safe: typeof m.isFamilySafe === 'boolean' ? m.isFamilySafe : null,
                is_shorts_eligible: typeof m.isShortsEligible === 'boolean' ? m.isShortsEligible : null,
                channel_url: m.ownerProfileUrl ?? null,
            };
        } catch {
            return null;
        }
    }

    /** @handle, c/name or user/name -> channel ID (UC…). */
    async function resolveChannel(handle, session) {
        let j;
        try {
            j = await innertube('navigation/resolve_url', { url: `https://www.youtube.com/${handle}` }, session);
        } catch (err) {
            if (err.apiError && (err.status === 404 || /not.?found/i.test(err.message))) throw Object.assign(new Error(`channel ${handle} not found`), { notFound: true });
            throw err;
        }
        const id = j.endpoint?.browseEndpoint?.browseId;
        if (!id) throw Object.assign(new Error(`channel ${handle} not found`), { notFound: true });
        return id;
    }

    /** Walks a browse/search response and returns videos in order plus the continuation token. */
    function collectVideos(j) {
        const out = [];
        const seen = new Set();
        let token = null;
        const add = (id, extra) => {
            if (id && ID_RE.test(id) && !seen.has(id)) {
                seen.add(id);
                out.push({ video_id: id, ...extra });
            }
        };
        const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? null;
        const walk = (o, depth) => {
            if (!o || typeof o !== 'object' || depth > 40) return;
            if (Array.isArray(o)) {
                o.forEach((x) => walk(x, depth + 1));
                return;
            }
            for (const [k, v] of Object.entries(o)) {
                if (!v || typeof v !== 'object') continue;
                if (['videoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer', 'compactVideoRenderer'].includes(k) && v.videoId) {
                    add(v.videoId, { title: text(v.title), length_text: text(v.lengthText) ?? v.lengthSeconds ?? null, published_text: text(v.publishedTimeText) });
                    continue;
                }
                if (k === 'reelItemRenderer' && v.videoId) {
                    add(v.videoId, { title: text(v.headline), is_short: true });
                    continue;
                }
                if (k === 'shortsLockupViewModel') {
                    add(v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? v.entityId?.replace(/^shorts-shelf-item-/, ''), { title: v.overlayMetadata?.primaryText?.content ?? null, is_short: true });
                    continue;
                }
                if (k === 'lockupViewModel' && /VIDEO/.test(v.contentType ?? '')) {
                    add(v.contentId, { title: v.metadata?.lockupMetadataViewModel?.title?.content ?? null });
                    continue;
                }
                if (k === 'continuationCommand' && v.token) token = v.token;
                walk(v, depth + 1);
            }
        };
        walk(j, 0);
        return { videos: out, token };
    }

    const TAB_PARAMS = { videos: 'EgZ2aWRlb3PyBgQKAjoA', shorts: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D', streams: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D' };

    /** Async generator of {video_id,…} for a channel tab, playlist or search query. */
    async function* listVideos(source, session) {
        let j;
        if (source.kind === 'search') j = await innertube('search', { query: source.id, params: 'EgIQAQ%3D%3D' }, session);
        else if (source.kind === 'playlist') j = await innertube('browse', { browseId: `VL${source.id}` }, session);
        else j = await innertube('browse', { browseId: source.id, params: decodeURIComponent(TAB_PARAMS[source.tab ?? 'videos']) }, session);
        if (source.kind === 'playlist' && /"alertMessageRenderer"/.test(JSON.stringify(j.alerts ?? [])) && !JSON.stringify(j).includes('playlistVideoRenderer')) {
            throw Object.assign(new Error('playlist does not exist or is private'), { notFound: true });
        }
        for (let page = 0; page < 200; page++) {
            const { videos, token } = collectVideos(j);
            for (const v of videos) yield v;
            if (!token || !videos.length) return;
            j = await innertube(source.kind === 'search' ? 'search' : 'browse', { continuation: token }, session);
        }
    }

    /** Downloads one caption track. `tlang` asks YouTube for its own machine translation of the track. */
    async function captions(track, session, { tlang } = {}) {
        const url = `${track.baseUrl.replace(/&fmt=[^&]*/g, '')}&fmt=srv3${tlang ? `&tlang=${encodeURIComponent(tlang)}` : ''}`;
        const r = await client.fetch({ url, headers: { 'user-agent': track.ua ?? WEB_UA }, ...(tlang ? { attempts: 1, soft: true } : {}) }, session);
        const segs = parseCaptions(String(r.body));
        if (!segs.length && String(r.body).length > 50) throw new Error('caption file could not be parsed');
        return segs;
    }

    /** Downloads an audio stream in 1 MB ranges (googlevideo throttles unranged downloads). */
    async function downloadAudio(fmt, session, maxBytes) {
        const total = fmt.bytes ?? maxBytes;
        if (total > maxBytes) throw new Error(`audio is ${Math.round(total / 1e6)} MB — above the ${Math.round(maxBytes / 1e6)} MB limit`);
        const parts = [];
        for (let start = 0; start < total; start += 1_000_000) {
            const end = Math.min(total - 1, start + 999_999);
            let r;
            try {
                r = await client.fetch({ url: `${fmt.url}&range=${start}-${end}`, headers: { 'user-agent': fmt.ua ?? WEB_UA }, responseType: 'buffer', timeoutMs: 60000, attempts: 2, soft: true, allow403: true }, session);
            } catch (err) {
                if (err instanceof BlockedError) throw new Error(`YouTube refused the audio download (${err.message})`);
                throw err;
            }
            if (r.status >= 400) throw new Error(`YouTube refused the audio download (HTTP ${r.status})`);
            parts.push(r.body);
            if (r.body.length < end - start + 1) break;
        }
        return Buffer.concat(parts);
    }

    return { player, webMeta, resolveChannel, listVideos, captions, downloadAudio, collectVideos };
}

// ---------- Caption parsing ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENT[e.toLowerCase()] ?? m;
    });
}
const clean = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const round = (n) => Math.round(n * 1000) / 1000;

/** Parses YouTube timedtext in srv3 (<p t d>), srv1 (<text start dur>) or json3 form into [{text, start, dur}] (seconds). */
export function parseCaptions(body) {
    const b = body.trim();
    const out = [];
    if (b.startsWith('{')) {
        let j;
        try {
            j = JSON.parse(b);
        } catch {
            return out;
        }
        for (const ev of j.events ?? []) {
            const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
            if (text) out.push({ text, start: round((ev.tStartMs ?? 0) / 1000), dur: round((ev.dDurationMs ?? 0) / 1000) });
        }
        return out;
    }
    for (const m of b.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
        const t = Number(m[1].match(/\bt="(\d+)"/)?.[1] ?? NaN);
        const d = Number(m[1].match(/\bd="(\d+)"/)?.[1] ?? 0);
        const text = clean(m[2]);
        if (text && Number.isFinite(t)) out.push({ text, start: round(t / 1000), dur: round(d / 1000) });
    }
    if (out.length) return out;
    for (const m of b.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
        const start = Number(m[1].match(/\bstart="([\d.]+)"/)?.[1] ?? NaN);
        const dur = Number(m[1].match(/\bdur="([\d.]+)"/)?.[1] ?? 0);
        const text = clean(m[2]);
        if (text && Number.isFinite(start)) out.push({ text, start: round(start), dur: round(dur) });
    }
    return out;
}

/**
 * Picks the caption track: preferred languages in order (manual before auto unless told otherwise),
 * then any manual track, then any auto track (when fallback is on).
 */
export function chooseTrack(tracks, languages, { preferManual = true, fallbackToAny = true } = {}) {
    if (!tracks.length) return null;
    const norm = (c) => String(c ?? '').toLowerCase();
    const matches = (t, lang) => norm(t.languageCode) === norm(lang) || norm(t.languageCode).split('-')[0] === norm(lang).split('-')[0];
    const order = (list) => (preferManual ? [...list.filter((t) => !t.isAuto), ...list.filter((t) => t.isAuto)] : [...list.filter((t) => t.isAuto), ...list.filter((t) => !t.isAuto)]);
    for (const lang of languages) {
        const exact = tracks.filter((t) => norm(t.languageCode) === norm(lang));
        const pick = order(exact)[0] ?? order(tracks.filter((t) => matches(t, lang)))[0];
        if (pick) return { track: pick, matchedPreferred: true };
    }
    if (!fallbackToAny) return null;
    return { track: order(tracks)[0], matchedPreferred: false };
}
