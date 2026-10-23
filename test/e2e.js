// End-to-end tests: runs the real actor (src/main.js) against the local YouTube mock. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-youtube.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = (a = 0.004, b = 0.008) => JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { transcript: { eventPriceUsd: a, eventTitle: 't' }, 'ai-transcript': { eventPriceUsd: b, eventTitle: 'a' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);

async function run(name, input, { mock, env = {}, storage, keep = false } = {}) {
    const dir = storage ?? join(ROOT, 'storage-test', name);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, 'datasets', 'default'), { recursive: true, force: true });
    rmSync(join(dir, 'datasets', 'charging_log'), { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify({ proxyConfiguration: { useApifyProxy: false }, ...input }));
    const t0 = Date.now();
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', APIFY_PROXY_PASSWORD: '', CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0',
            YT_BASE: mock.base, GTX_BASE: mock.base, OPENAI_BASE: `${mock.base}/v1/audio/transcriptions`, GROQ_BASE: `${mock.base}/v1/audio/transcriptions`, HTTP_RATE_SCALE: '30',
            ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICING(), APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}', ...env },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, 'run.log'), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const kv = (k) => (existsSync(join(dir, 'key_value_stores', 'default', `${k}.json`)) ? JSON.parse(readFileSync(join(dir, 'key_value_stores', 'default', `${k}.json`), 'utf8')) : null);
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    return { code, rows, ok: rows.filter((r) => r.status === 'ok'), failed: rows.filter((r) => r.status !== 'ok'), charges, chargeCount: charges.reduce((s, c) => s + (c.count ?? 1), 0),
        summary: kv('RUN_SUMMARY'), logs, dir, secs: Math.round((Date.now() - t0) / 100) / 10 };
}

const results = [];
const check = (label, pass, detail = '') => {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const billed = (r, event = 'transcript') => r.chargeCount === r.ok.length && r.charges.every((c) => c.eventName === event || (Array.isArray(event) && event.includes(c.eventName)));
const statusOf = (r, id) => r.rows.filter((x) => x.video_id === id).map((x) => x.status).join(',');
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const mock = await startMock();

if (want('videos')) {
    console.log('\n=== 1. SINGLE VIDEOS (formats, translation fallback, failures, bot-check retry) ===');
    const r = await run('videos', {
        urls: ['https://www.youtube.com/watch?v=okVideo0001&t=10s', 'https://youtu.be/okVideo0001', 'https://www.youtube.com/shorts/deOnly00001', 'noCaption01', 'https://m.youtube.com/watch?v=ageLimited1', 'https://www.youtube.com/embed/goneVideo01', 'https://vimeo.com/123', 'botFlaky001', 'iosBlocked1', 'labelBlock1'],
        translateTo: 'hi', chunkWords: 20, chunkOverlapWords: 5, transcriptKeywords: ['machine learning', 'recaptcha'], includeTimestampedText: true, includeParagraphs: true,
    }, { mock });
    const ok = r.ok.find((x) => x.video_id === 'okVideo0001');
    check('4 transcripts saved (ok, German fallback, bot-checked-then-ok, IOS-blocked), duplicate URL removed', r.code === 0 && r.ok.length === 4 && r.summary.skipReasons.duplicate_video === 1, `${r.secs}s ${r.ok.map((x) => x.video_id)}`);
    check('only transcripts are charged, failed rows free', billed(r) && r.chargeCount === 4);
    check('human captions preferred over auto (en manual)', ok?.is_auto_generated === false && ok.language === 'en' && ok.matched_preferred_language === true);
    check('metadata complete (title, channel, views, likes, category, publish date, tags)', ok && ok.title && ok.channel === 'Mock Channel' && ok.view_count === 98765 && ok.like_count === 1234 && ok.category === 'Education' && ok.publish_date.startsWith('2025-06-01') && ok.tags.length === 2 && ok.available_languages.join() === 'en,de');
    check('HTML entities decoded (&amp; and &#39;)', ok?.transcript.includes('recaptcha & that') && ok.transcript.includes("Let's move"));
    check('SRT + VTT well-formed, end times never overlap next cue', /^1\n00:00:00,000 --> 00:00:06,000\n/.test(ok?.srt ?? '') && ok.vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:06.000'), ok?.srt.split('\n').slice(0, 2).join(' | '));
    check('segments, timestamped text and paragraphs', ok?.data.length === 10 && ok.lines.length === 10 && ok.transcript_timestamped.startsWith('[0:00] Welcome') && ok.paragraphs.length >= 1);
    check('chapters from description with their own text', ok?.chapters.length === 3 && ok.chapters[1].title === 'Middle part' && ok.chapters[1].text.startsWith("Let's move") && ok.chapters[2].url.endsWith('&t=40s'));
    check('LLM chunks with overlap and deep links', ok?.chunks.length >= 3 && ok.chunks.every((c) => c.word_count >= 1 && c.url.includes('&t=')) && ok.chunks[1].start < ok.chunks[0].end + 7, `${ok?.chunks.length} chunks`);
    check('keyword hits incl. a transcript that says "recaptcha" (not mistaken for a block)', ok?.keyword_match_count === 3 && ok.keyword_matches.some((k) => k.keyword === 'recaptcha'), JSON.stringify(ok?.keyword_matches.map((k) => `${k.keyword}@${k.time_hms}`)));
    check('YouTube translation 429 -> Google Translate fallback, timings kept', ok?.translation_source.startsWith('google translate') && ok.transcript_translated.startsWith('[hi] Welcome') && ok.data_translated.length === ok.data.length && ok.data_translated[3].start === ok.data[3].start);
    check('YouTube translation 429s did not hurt the route', r.summary.routes[0].blocked === 4 && mock.hits.tlang >= 4 && r.summary.translation.google_translate === 4, JSON.stringify(r.summary.routes));
    const de = r.ok.find((x) => x.video_id === 'deOnly00001');
    check('no English -> falls back to German, flagged as not preferred', de?.language === 'de' && de.matched_preferred_language === false && de.transcript.startsWith('Hallo'));
    check('statuses: no_captions / age_restricted / unavailable / invalid_input with fix hints', statusOf(r, 'noCaption01') === 'no_captions' && statusOf(r, 'ageLimited1') === 'age_restricted' && statusOf(r, 'goneVideo01') === 'unavailable' && r.failed.some((x) => x.status === 'invalid_input') && r.failed.every((x) => x.fix_hint));
    check('bot-checked video retried and saved', statusOf(r, 'botFlaky001') === 'ok');
    check('visitor ID fetched and sent with every app-client request', mock.hits.visitor >= 1 && !mock.hits.noVisitor, `visitor fetches ${mock.hits.visitor}`);
    check('IOS bot-checked -> ANDROID client used', r.ok.find((x) => x.video_id === 'iosBlocked1')?.player_client === 'android');
    check('label-restricted video -> unavailable row that still has its title', r.failed.find((x) => x.video_id === 'labelBlock1')?.status === 'unavailable' && r.failed.find((x) => x.video_id === 'labelBlock1').title === 'Label restricted');
    check('RUN_SUMMARY: languages, caption kinds, statuses', r.summary.captionKinds.manual === 2 && r.summary.captionKinds.auto === 2 && r.summary.statusCounts.ok === 4 && r.summary.stopReason === 'completed');
}

if (want('lists')) {
    console.log('\n=== 2. CHANNELS, PLAYLISTS, SEARCH (pagination, tabs, dedupe, not found) ===');
    const r = await run('lists', {
        urls: ['https://www.youtube.com/@mockchannel', 'https://www.youtube.com/playlist?list=PLmockplaylist01', 'https://www.youtube.com/@mockchannel/shorts', 'https://www.youtube.com/@nobody_here', 'https://www.youtube.com/playlist?list=PLmissing00000'],
        searchQueries: ['mock query', 'nothing at all'], maxVideosPerSource: 20, includeSrt: false, includeVtt: false, includeSegments: false,
    }, { mock });
    const src = (k) => r.summary.sources.find((s) => s.input.includes(k));
    check('channel paginates past page 1 and stops at the per-source limit', src('@mockchannel')?.found === 20 && r.ok.some((x) => x.video_id === 'chanVid0018'), `${src('@mockchannel')?.found}`);
    check('playlist read, video already queued from the channel is not repeated', src('PLmock')?.found === 2 && r.summary.skipReasons.duplicate_video === 1);
    check('Shorts tab from URL gives Shorts, marked is_short', src('/shorts')?.found === 3 && r.ok.filter((x) => x.video_id.startsWith('chanShort')).every((x) => x.is_short));
    check('search paginates (5 results)', src('mock query')?.found === 5, `${src('mock query')?.found}`);
    check('unknown handle -> not_found, missing playlist -> not_found, empty search -> no_results', r.failed.filter((x) => x.status === 'not_found').length === 2 && r.failed.some((x) => x.status === 'no_results'), r.failed.map((x) => x.status).join(','));
    check('30 transcripts, one charge each, output format switches respected', r.ok.length === 30 && billed(r) && r.ok.every((x) => x.srt === undefined && x.data === undefined), `${r.ok.length} in ${r.secs}s`);
}

if (want('languages')) {
    console.log('\n=== 3. LANGUAGE OPTIONS ===');
    const a = await run('lang-all', { urls: ['okVideo0001'], allLanguages: true }, { mock });
    check('allLanguages -> one row per track (en manual, en auto, de), each charged', a.ok.length === 3 && billed(a) && a.ok.filter((x) => x.is_auto_generated).length === 1, a.ok.map((x) => `${x.language}${x.is_auto_generated ? '(auto)' : ''}`).join(','));
    const b = await run('lang-strict', { urls: ['deOnly00001', 'okVideo0001'], languages: ['fr'], fallbackToAnyLanguage: false }, { mock });
    check('no fallback -> no_matching_language rows listing the available languages, nothing charged', b.ok.length === 0 && b.chargeCount === 0 && b.failed.every((x) => x.status === 'no_matching_language' && /de/.test(x.error)));
    const c = await run('lang-auto', { urls: ['okVideo0001'], preferManualCaptions: false, languages: ['en-GB'] }, { mock });
    check('preferManual off -> auto track; "en-GB" matches "en"', c.ok[0]?.is_auto_generated === true && c.ok[0].language === 'en');
}

if (want('ai')) {
    console.log('\n=== 4. AI TRANSCRIPTION FALLBACK (own key) ===');
    const a = await run('ai-ok', { urls: ['noCaption01', 'okVideo0001'], aiProvider: 'openai', aiApiKey: 'sk-good' }, { mock });
    const ai = a.ok.find((x) => x.video_id === 'noCaption01');
    check('caption-less video transcribed from audio, charged as ai-transcript', ai?.transcript_source === 'ai' && ai.transcript === 'Hello from the audio. This was transcribed by AI.' && a.charges.filter((c) => c.eventName === 'ai-transcript').length === 1 && billed(a, ['transcript', 'ai-transcript']));
    check('audio downloaded in ranges, smallest stream used, SRT built from AI segments', mock.hits.audio >= 2 && /00:00:04,200 --> 00:00:09,000/.test(ai?.srt ?? ''));
    check('videos with captions still use captions (no AI call)', a.ok.find((x) => x.video_id === 'okVideo0001')?.transcript_source === 'youtube_captions' && mock.hits.whisper === 1);
    const b = await run('ai-badkey', { urls: ['noCaption01'], aiProvider: 'groq', aiApiKey: 'sk-wrong' }, { mock });
    check('bad API key -> free no_captions row explaining the key error', b.ok.length === 0 && b.chargeCount === 0 && /API key/.test(b.failed[0]?.error ?? ''), b.failed[0]?.error);
    const c = await run('ai-long', { urls: ['noCaption01'], aiProvider: 'openai', aiApiKey: 'sk-good', aiMaxMinutes: 1 }, { mock });
    check('longer than the AI limit -> skipped, not charged', c.ok.length === 0 && /above your AI limit/.test(c.failed[0]?.error ?? ''));
}

if (want('filters')) {
    console.log('\n=== 5. FILTERS (never charged) ===');
    const r = await run('filters', { urls: ['okVideo0001', 'shortVid001', 'oldVideo001', 'botFlaky001', 'chanVid0001'], skipShorts: true, publishedAfter: '2020-01-01', maxDurationSeconds: 110 }, { mock });
    check('short, old and too-long videos skipped; 2 saved', r.ok.length === 2 && billed(r) && r.summary.skipReasons.filtered_short === 1 && r.summary.skipReasons.filtered_published_before_date === 1 && r.summary.skipReasons.filtered_too_long === 1, JSON.stringify(r.summary.skipReasons));
    const rel = await run('filters-rel', { urls: ['okVideo0001', 'chanVid0001'], publishedAfter: '100 years' }, { mock });
    check('relative date ("100 years") accepted', rel.ok.length === 2);
    const bad = await run('filters-bad', { urls: ['okVideo0001'], publishedAfter: 'last tuesday' }, { mock });
    check('invalid date -> run fails with a clear message', bad.code !== 0 && /not a valid date/.test(bad.logs));
}

if (want('routes')) {
    console.log('\n=== 6. PROXY FALLBACK (flagged proxy -> next route) ===');
    const a = await run('routes', { urls: ['okVideo0001', 'chanVid0001', 'chanVid0002'], proxyConfiguration: { useApifyProxy: false, proxyUrls: [mock.proxyUrl] } }, { mock });
    check('bot-checked proxy abandoned, all videos saved via the next route', a.ok.length === 3 && billed(a) && a.summary.requests.routeSwitches === 1 && a.summary.routes[1].ok > 0, JSON.stringify(a.summary.routes));
    check('route switch explained in the log', /keeps blocking "custom proxy".*Switching to "no proxy/.test(a.logs));
    const b = await run('routes-off', { urls: ['okVideo0001'], proxyConfiguration: { useApifyProxy: false, proxyUrls: [mock.proxyUrl] }, proxyFallback: false }, { mock });
    check('fallback off -> blocked row with a fix hint, nothing charged', b.ok.length === 0 && b.chargeCount === 0 && b.failed[0]?.status === 'blocked' && /bot check/.test(b.failed[0].error), b.failed[0]?.error);
}

if (want('dedupe')) {
    console.log('\n=== 7. SKIP VIDEOS FROM PREVIOUS RUNS ===');
    const input = { urls: ['https://www.youtube.com/@mockchannel'], maxVideosPerSource: 5, skipPreviouslyScraped: true, dedupeStoreName: 'e2e-seen' };
    const a = await run('dedupe', input, { mock });
    const b = await run('dedupe', input, { mock, keep: true });
    check('second run saves and charges nothing new', a.ok.length === 5 && b.ok.length === 0 && b.chargeCount === 0 && b.summary.skipReasons.seen_in_previous_run === 5, `${a.ok.length} then ${b.ok.length}`);
    const c = await run('dedupe', { ...input, maxVideosPerSource: 8 }, { mock, keep: true });
    check('raising the limit only adds the 3 new videos', c.ok.length === 3 && c.chargeCount === 3);
}

if (want('limits')) {
    console.log('\n=== 8. MAX COST, MAX RESULTS, TIMEOUT ===');
    const mc = await run('maxcost', { urls: ['https://www.youtube.com/@mockchannel'], maxVideosPerSource: 20 }, { mock, env: { ACTOR_MAX_TOTAL_CHARGE_USD: '4', APIFY_ACTOR_PRICING_INFO: PRICING(1, 1) } });
    check('max cost $4 at $1/transcript -> exactly 4 saved and charged', mc.ok.length === 4 && mc.chargeCount === 4 && mc.summary.stopReason === 'max_cost_per_run_reached', `${mc.ok.length} saved, ${mc.chargeCount} charged, ${mc.summary.stopReason}`);
    const mr = await run('maxresults', { urls: ['https://www.youtube.com/@mockchannel'], maxVideosPerSource: 20, maxResults: 7 }, { mock });
    check('maxResults 7 -> exactly 7', mr.ok.length === 7 && mr.chargeCount === 7 && mr.summary.stopReason === 'max_results_reached');
    const slow = await startMock({ delayMs: 400 });
    const to = await run('timeout', { urls: ['https://www.youtube.com/@mockchannel'], maxVideosPerSource: 25 }, { mock: slow, env: { ACTOR_TIMEOUT_AT: new Date(Date.now() + 62000).toISOString(), HTTP_RATE_SCALE: '1' } });
    check('stops 45 s before timeout, saves what it has and writes RUN_SUMMARY', to.code === 0 && to.ok.length > 0 && to.ok.length < 25 && /timeout_approaching/.test(to.summary?.stopReason ?? '') && billed(to), `${to.ok.length} saved in ${to.secs}s`);
    slow.close();
}

mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
