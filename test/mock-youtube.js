// Local stand-in for YouTube InnerTube, timedtext, googlevideo audio, Google Translate (gtx) and the Whisper APIs.
import http from 'node:http';

const pad = (n) => String(n).padStart(4, '0');
const CHANNEL_ID = 'UCmockchannel00000000000';
const LINES = [
    'Welcome to this video about machine learning.', 'Today we look at how models learn from data.', 'Some sites protect forms with a recaptcha &amp; that is fine.',
    'Machine learning needs good data.', 'Let&#39;s move on to the middle part.', 'Here we train the first model.', 'The loss goes down as we train.',
    'Now the final part of the video.', 'We test the model on new data.', 'Thanks for watching and see you next time.',
];
const DE_LINES = ['Hallo und willkommen.', 'Heute sprechen wir über Daten.', 'Danke fürs Zuschauen.'];

/** Videos the mock knows. Any other well-formed ID becomes a generic video with an auto English track. */
const VIDEOS = {
    okVideo0001: { title: 'Machine learning explained', duration: 60, tracks: [['en', false], ['en', true], ['de', false]], description: 'Chapters:\n0:00 Intro\n0:20 Middle part\n0:40 Final part\n\nThanks!', publish: '2025-06-01' },
    deOnly00001: { title: 'Deutsches Video', duration: 30, tracks: [['de', false]], lines: DE_LINES, publish: '2025-03-03' },
    noCaption01: { title: 'Video without captions', duration: 90, tracks: [], audio: true, publish: '2025-02-02' },
    ageLimited1: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age. This video may be inappropriate for some users.' },
    goneVideo01: { status: 'ERROR', reason: 'This video is unavailable' },
    shortVid001: { title: 'A short', duration: 30, tracks: [['en', true]], shorts: true, publish: '2025-05-05' },
    oldVideo001: { title: 'An old video', duration: 100, tracks: [['en', true]], publish: '2015-01-01' },
    botFlaky001: { title: 'Flaky one', duration: 60, tracks: [['en', true]], botFirst: 2, publish: '2025-04-04' },
    iosBlocked1: { title: 'IOS refused', duration: 60, tracks: [['en', true]], blockClients: ['IOS'], publish: '2025-04-04' },
    labelBlock1: { title: 'Label restricted', duration: 200, tracks: [], unplayable: true, publish: '2025-04-04' },
};
const video = (id) => VIDEOS[id] ?? { title: `Generic ${id}`, duration: 120, tracks: [['en', true]], publish: '2025-07-07' };

export async function startMock({ delayMs = 0 } = {}) {
    const hits = {};
    const flaky = {};
    const hit = (k) => { hits[k] = (hits[k] ?? 0) + 1; };
    let base;
    const send = (res, code, body, type = 'application/json') => {
        res.writeHead(code, { 'content-type': type });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const runs = (t) => ({ runs: [{ text: t }] });

    const BOT = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
    function player(id, client, visitorData) {
        const v = video(id);
        if (client !== 'WEB' && !visitorData) { hit('noVisitor'); return BOT; } // like real YouTube: app clients without a visitor ID are bot-checked
        if (v.blockClients?.includes(client)) return BOT;
        if (v.botFirst && client !== 'WEB') {
            flaky[id] = (flaky[id] ?? 0) + 1;
            if (flaky[id] <= v.botFirst) return { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
        }
        if (v.status) return { playabilityStatus: { status: v.status, reason: v.reason } };
        if (v.unplayable && client !== 'WEB') return { playabilityStatus: { status: 'UNPLAYABLE', reason: 'This video is not available' }, videoDetails: { videoId: id, title: v.title, author: 'Mock Channel', channelId: CHANNEL_ID, lengthSeconds: String(v.duration), viewCount: '5' } };
        if (client === 'WEB') {
            return { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' }, // like the real WEB client: playback refused, microformat present
                microformat: { playerMicroformatRenderer: { category: 'Education', publishDate: `${v.publish}T08:00:00-07:00`, likeCount: '1234', isFamilySafe: true, isShortsEligible: Boolean(v.shorts), ownerProfileUrl: 'http://www.youtube.com/@mockchannel' } } };
        }
        return {
            playabilityStatus: { status: 'OK' },
            videoDetails: { videoId: id, title: v.title, author: 'Mock Channel', channelId: CHANNEL_ID, lengthSeconds: String(v.duration), viewCount: '98765', shortDescription: v.description ?? 'A mock video.', keywords: ['mock', 'test'], isLiveContent: false, thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] } },
            captions: v.tracks.length ? { playerCaptionsTracklistRenderer: { captionTracks: v.tracks.map(([lang, asr]) => ({ baseUrl: `/api/timedtext?v=${id}&lang=${lang}${asr ? '&kind=asr' : ''}`, name: { runs: [{ text: `${lang === 'de' ? 'German' : 'English'}${asr ? ' (auto-generated)' : ''}` }] }, languageCode: lang, ...(asr ? { kind: 'asr' } : {}), isTranslatable: true })) } } : undefined,
            streamingData: v.audio ? { adaptiveFormats: [
                { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: '1500000', url: `${base}/videoplayback?id=${id}&itag=140` },
                { itag: 249, mimeType: 'audio/webm; codecs="opus"', bitrate: 50000, contentLength: '1500000', url: `${base}/videoplayback?id=${id}&itag=249` },
            ] } : {},
        };
    }

    function timedtext(u) {
        const id = u.searchParams.get('v');
        const lang = u.searchParams.get('lang');
        const asr = u.searchParams.get('kind') === 'asr';
        const v = video(id);
        let lines = v.lines ?? (VIDEOS[id] ? LINES : [`Generic transcript for ${id}.`, 'Second line of the generic transcript.', 'Third and last line.']);
        if (lang === 'de' && !v.lines) lines = DE_LINES;
        if (asr) lines = lines.map((l) => l.toLowerCase().replace(/[.,]/g, ''));
        const step = Math.max(1, Math.floor((v.duration * 1000) / lines.length));
        return `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>${lines.map((l, i) => `<p t="${i * step}" d="${step + 500}">${l}</p>`).join('')}</body></timedtext>`;
    }

    const listPage = (ids, renderer, next) => ({ contents: { items: [...ids.map((id) => ({ [renderer]: { videoId: id, title: runs(`Video ${id}`), lengthText: { simpleText: '2:00' } } })), ...(next ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: next } } } }] : [])] } });
    const chanVids = Array.from({ length: 25 }, (_, i) => `chanVid${pad(i + 1)}`);

    function browse(b) {
        if (b.continuation === 'chan-p2') return { onResponseReceivedActions: [{ appendContinuationItemsAction: listPage(chanVids.slice(15), 'gridVideoRenderer').contents }] };
        if (b.continuation === 'search-p2') return { onResponseReceivedCommands: [{ appendContinuationItemsAction: listPage(['srchVid0004', 'srchVid0005'], 'videoRenderer').contents }] };
        if (b.browseId === CHANNEL_ID) {
            const params = decodeURIComponent(b.params ?? '');
            if (params.startsWith('EgZzaG9ydH')) return { contents: { items: ['chanShort01', 'chanShort02', 'chanShort03'].map((id) => ({ shortsLockupViewModel: { entityId: `shorts-shelf-item-${id}`, overlayMetadata: { primaryText: { content: `Short ${id}` } }, onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } } } })) } };
            return listPage(chanVids.slice(0, 15), 'gridVideoRenderer', 'chan-p2');
        }
        if (b.browseId === 'VLPLmockplaylist01') return listPage(['okVideo0001', 'deOnly00001', 'chanVid0001'], 'playlistVideoRenderer');
        if (b.browseId?.startsWith('VL')) return { alerts: [{ alertMessageRenderer: { text: runs('The playlist does not exist.') } }] };
        return null;
    }

    const server = http.createServer(async (req, res) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const u = new URL(req.url, 'http://x');
        const body = await readBody(req);
        const j = () => JSON.parse(body.toString() || '{}');
        const path = u.pathname;
        if (path === '/youtubei/v1/player') {
            const b = j();
            const c = b.context?.client?.clientName;
            hit(`player:${c}`);
            if (b.context?.client?.visitorData && req.headers['x-goog-visitor-id'] !== b.context.client.visitorData) return send(res, 400, { error: { code: 400, message: 'visitor mismatch' } });
            return send(res, 200, player(b.videoId, c, b.context?.client?.visitorData));
        }
        if (path === '/youtubei/v1/navigation/resolve_url') {
            hit('resolve');
            const b = j();
            if (/@mockchannel$/.test(b.url)) return send(res, 200, { endpoint: { browseEndpoint: { browseId: CHANNEL_ID } } });
            return send(res, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
        }
        if (path === '/youtubei/v1/browse') {
            hit('browse');
            const r = browse(j());
            return r ? send(res, 200, r) : send(res, 400, { error: { code: 400, message: 'Request contains an invalid argument.' } });
        }
        if (path === '/youtubei/v1/search') {
            hit('search');
            const b = j();
            if (b.continuation) return send(res, 200, browse(b));
            if (b.query === 'nothing at all') return send(res, 200, { contents: {} });
            return send(res, 200, listPage(['srchVid0001', 'srchVid0002', 'srchVid0003'], 'videoRenderer', 'search-p2'));
        }
        if (path === '/sw.js_data') {
            hit('visitor');
            return send(res, 200, `)]}'\n[["yt.sw.adr",null,[[["en","US",null,null,null,null,"CgtNb2NrVmlzaXRvcijX%3D%3D"]]]]]`, 'application/json');
        }
        if (path === '/api/timedtext') {
            hit('timedtext');
            if (u.searchParams.get('tlang')) { hit('tlang'); return send(res, 429, '<html><body>Too many requests</body></html>', 'text/html'); }
            return send(res, 200, timedtext(u), 'text/xml; charset=UTF-8');
        }
        if (path === '/videoplayback') {
            hit('audio');
            const [a, z] = (u.searchParams.get('range') ?? '0-1499999').split('-').map(Number);
            return send(res, 200, Buffer.alloc(Math.min(z, 1499999) - a + 1, 7), 'audio/mp4');
        }
        if (path === '/translate_a/single') {
            hit('gtx');
            const q = new URLSearchParams(body.toString()).get('q') ?? '';
            const tl = u.searchParams.get('tl');
            return send(res, 200, [[[q.split('\n').map((l) => `[${tl}] ${l}`).join('\n'), q]], null, 'auto']);
        }
        if (path === '/v1/audio/transcriptions') {
            hit('whisper');
            if (req.headers.authorization !== 'Bearer sk-good') return send(res, 401, { error: { message: 'Incorrect API key provided' } });
            if (!/name="file"/.test(body.toString('latin1')) || !/whisper-1|whisper-large/.test(body.toString('latin1'))) return send(res, 400, { error: { message: 'bad form' } });
            return send(res, 200, { text: 'Hello from the audio. This was transcribed by AI.', language: 'english', duration: 90, segments: [{ start: 0, end: 4.2, text: ' Hello from the audio.' }, { start: 4.2, end: 9, text: ' This was transcribed by AI.' }] });
        }
        return send(res, 404, { error: { code: 404, message: 'not found' } });
    });

    // A proxy pool YouTube has flagged: every request through it gets the bot check.
    const proxy = http.createServer((req, res) => {
        hit('viaProxy');
        if (req.url.includes('/youtubei/')) return send(res, 200, { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
        return send(res, 200, '<!DOCTYPE html><html><body>Sign in to confirm you’re not a bot</body></html>', 'text/html');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, proxyUrl: `http://127.0.0.1:${proxy.address().port}`, hits, CHANNEL_ID, close: () => { server.close(); proxy.close(); } });
        }));
    });
}
