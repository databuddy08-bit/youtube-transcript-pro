import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeInput, parseCaptions, chooseTrack, decodeEntities, makeYouTube } from '../src/youtube.js';
import { toSrt, toVtt, toText, chunks, chapters, keywordHits, paragraphs, hms } from '../src/format.js';
import { pickAudio } from '../src/ai.js';

test('input parsing: every YouTube URL shape', () => {
    const k = (s) => { const r = parseYouTubeInput(s); return r.invalid ? 'invalid' : `${r.kind}:${r.id}${r.tab ? `/${r.tab}` : ''}`; };
    assert.equal(k('dQw4w9WgXcQ'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'video:dQw4w9WgXcQ');
    assert.equal(k('youtu.be/dQw4w9WgXcQ?si=abc'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://youtube.com/shorts/dQw4w9WgXcQ'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://www.youtube.com/live/dQw4w9WgXcQ'), 'video:dQw4w9WgXcQ');
    assert.equal(k('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'video:dQw4w9WgXcQ');
    assert.equal(k('@3blue1brown'), 'handle:@3blue1brown');
    assert.equal(k('https://www.youtube.com/@3blue1brown/shorts'), 'handle:@3blue1brown/shorts');
    assert.equal(k('https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw/streams'), 'channel:UCYO_jab_esuFRV4b17AJtAw/streams');
    assert.equal(k('https://www.youtube.com/c/LinusTechTips'), 'handle:c/LinusTechTips');
    assert.equal(k('https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab'), 'playlist:PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab');
    assert.equal(k('https://vimeo.com/123'), 'invalid');
    assert.equal(k('https://www.youtube.com/feed/trending'), 'invalid');
    assert.equal(parseYouTubeInput('  '), null);
});

test('caption parsing: srv3, srv1, json3, entities and tags', () => {
    assert.deepEqual(parseCaptions('<timedtext><body><p t="1500" d="2000">Hi &amp; <s>there</s></p><p t="4000" d="0"> </p></body></timedtext>'), [{ text: 'Hi & there', start: 1.5, dur: 2 }]);
    assert.deepEqual(parseCaptions('<transcript><text start="0.5" dur="1.25">It&#39;s ok</text></transcript>'), [{ text: "It's ok", start: 0.5, dur: 1.25 }]);
    assert.deepEqual(parseCaptions('{"events":[{"tStartMs":0,"dDurationMs":900,"segs":[{"utf8":"a "},{"utf8":"b"}]},{"tStartMs":5}]}'), [{ text: 'a b', start: 0, dur: 0.9 }]);
    assert.equal(decodeEntities('&#x1F600;&quot;&nbsp;&unknown;'), '😀" &unknown;');
});

test('track choice: preference order, manual vs auto, regional codes, fallback', () => {
    const T = [{ languageCode: 'en', isAuto: true }, { languageCode: 'en', isAuto: false }, { languageCode: 'pt-BR', isAuto: false }, { languageCode: 'de', isAuto: true }];
    assert.deepEqual(chooseTrack(T, ['en']).track, T[1]);
    assert.deepEqual(chooseTrack(T, ['en'], { preferManual: false }).track, T[0]);
    assert.deepEqual(chooseTrack(T, ['pt']).track, T[2]);
    assert.deepEqual(chooseTrack(T, ['fr', 'de']).track, T[3]);
    assert.equal(chooseTrack(T, ['fr']).matchedPreferred, false);
    assert.equal(chooseTrack(T, ['fr'], { fallbackToAny: false }), null);
    assert.equal(chooseTrack([], ['en']), null);
});

const SEGS = [{ text: 'one two three', start: 0, dur: 5 }, { text: 'four five', start: 3, dur: 2 }, { text: 'six seven eight', start: 10, dur: 1 }, { text: 'nine ten', start: 3661.5, dur: 2 }];

test('SRT/VTT timing: overlapping auto-caption cues are clipped to the next start', () => {
    const srt = toSrt(SEGS);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:03,000\none two three\n/);
    assert.match(srt, /4\n01:01:01,500 --> 01:01:03,500\nnine ten/);
    assert.match(toVtt(SEGS), /^WEBVTT\n\n00:00:00\.000 --> 00:00:03\.000/);
    assert.equal(toText(SEGS), 'one two three four five six seven eight nine ten');
    assert.equal(hms(3661.5), '1:01:01');
    assert.equal(hms(75), '1:15');
});

test('chunks: sizes, overlap, deep links; paragraphs split on pauses', () => {
    const c = chunks(SEGS, 'abcdefghijk', 5);
    assert.deepEqual(c.map((x) => x.word_count), [5, 5]);
    assert.equal(c[1].url, 'https://www.youtube.com/watch?v=abcdefghijk&t=10s');
    const o = chunks(SEGS, 'abcdefghijk', 5, 2);
    assert.ok(o.length >= 3 && o[1].text.startsWith('four five'));
    assert.deepEqual(chunks(SEGS, 'x', 0), []);
    assert.deepEqual(paragraphs(SEGS).map((p) => p.start), [0, 10, 3661.5]);
});

test('chapters: YouTube rules (>= 3, starts at 0:00, increasing), text per chapter', () => {
    const d = 'Intro text\n00:00 Start\n0:09 - Middle\n1:00:00 | The end\n';
    const ch = chapters(d, SEGS, 'abcdefghijk', 3700);
    assert.deepEqual(ch.map((x) => [x.title, x.start, x.end]), [['Start', 0, 9], ['Middle', 9, 3600], ['The end', 3600, 3700]]);
    assert.equal(ch[1].text, 'six seven eight');
    assert.deepEqual(chapters('0:10 a\n0:20 b\n0:30 c', SEGS, 'x'), []);
    assert.deepEqual(chapters('0:00 a\n0:20 b', SEGS, 'x'), []);
    assert.deepEqual(chapters('0:00 a\n0:30 b\n0:20 c', SEGS, 'x'), []);
});

test('keyword hits: whole words, accents, phrases across two lines', () => {
    const s = [{ text: 'We love Café culture', start: 0, dur: 1 }, { text: 'machine', start: 2, dur: 1 }, { text: 'learning is fun, cafeteria', start: 3, dur: 1 }];
    const h = keywordHits(s, ['cafe', 'machine learning', 'fun'], 'abcdefghijk');
    assert.deepEqual(h.map((x) => `${x.keyword}@${x.time}`), ['cafe@0', 'machine learning@3', 'fun@3']);
    assert.equal(h[0].url, 'https://www.youtube.com/watch?v=abcdefghijk&t=0s');
});

test('collectVideos: grid, playlist, shorts lockups, lockupViewModel, continuation, dedupe', () => {
    const yt = makeYouTube({ route: {} });
    const j = { a: [{ gridVideoRenderer: { videoId: 'aaaaaaaaaaa', title: { runs: [{ text: 'A' }] } } }, { playlistVideoRenderer: { videoId: 'bbbbbbbbbbb', title: { simpleText: 'B' } } },
        { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'ccccccccccc' } } } } }, { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'ddddddddddd' } },
        { gridVideoRenderer: { videoId: 'aaaaaaaaaaa' } }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT' } } } }] };
    const r = yt.collectVideos(j);
    assert.deepEqual(r.videos.map((v) => v.video_id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']);
    assert.equal(r.videos[2].is_short, true);
    assert.equal(r.token, 'NEXT');
});

test('AI audio: the smallest stream is chosen', () => {
    assert.equal(pickAudio([{ itag: 140, bitrate: 130000 }, { itag: 249, bitrate: 50000 }]).itag, 249);
    assert.equal(pickAudio([]), null);
});
