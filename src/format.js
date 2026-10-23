// Transcript outputs: plain text, SRT, VTT, timestamped text, paragraphs, LLM chunks, chapters, keyword hits.
import { watchUrl } from './youtube.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
function clock(sec, sep) {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}
export const hms = (sec) => {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
export const deepLink = (id, sec) => `${watchUrl(id)}&t=${Math.floor(sec)}s`;

/** End of a cue: its own duration, but never past the next cue (auto captions overlap). */
const endOf = (segs, i) => {
    const own = segs[i].start + (segs[i].dur || 2);
    const next = segs[i + 1]?.start;
    return next !== undefined && next > segs[i].start ? Math.min(own, next) : own;
};

export const toText = (segs) => segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
export const toSrt = (segs) => segs.map((s, i) => `${i + 1}\n${clock(s.start, ',')} --> ${clock(endOf(segs, i), ',')}\n${s.text}\n`).join('\n');
export const toVtt = (segs) => `WEBVTT\n\n${segs.map((s, i) => `${clock(s.start, '.')} --> ${clock(endOf(segs, i), '.')}\n${s.text}\n`).join('\n')}`;
export const toTimestamped = (segs) => segs.map((s) => `[${hms(s.start)}] ${s.text}`).join('\n');
export const wordCount = (t) => (t.match(/\S+/g) ?? []).length;

/** Paragraphs: break on long pauses (>2 s) or every ~80 words, so the text reads like prose. */
export function paragraphs(segs, maxWords = 80) {
    const out = [];
    let cur = [];
    let words = 0;
    segs.forEach((s, i) => {
        cur.push(s);
        words += wordCount(s.text);
        const gap = segs[i + 1] ? segs[i + 1].start - endOf(segs, i) : 99;
        if (words >= maxWords || gap > 2) {
            out.push({ start: cur[0].start, text: toText(cur) });
            cur = [];
            words = 0;
        }
    });
    if (cur.length) out.push({ start: cur[0].start, text: toText(cur) });
    return out;
}

/** LLM/RAG chunks of ~N words with start/end times and a deep link to the exact moment. */
export function chunks(segs, videoId, size = 300, overlap = 0) {
    if (!size) return [];
    const out = [];
    let i = 0;
    while (i < segs.length) {
        let words = 0;
        let j = i;
        while (j < segs.length && words < size) words += wordCount(segs[j++].text);
        const part = segs.slice(i, j);
        out.push({ index: out.length, start: part[0].start, end: Math.round(endOf(segs, j - 1) * 1000) / 1000, start_hms: hms(part[0].start), word_count: words, text: toText(part), url: deepLink(videoId, part[0].start) });
        if (j >= segs.length) break;
        let back = 0;
        let k = j;
        while (overlap && k > i + 1 && back < overlap) back += wordCount(segs[--k].text);
        i = overlap ? Math.max(i + 1, k) : j;
    }
    return out;
}

/**
 * Chapters from the description ("0:00 Intro" lines). Only used when the description lists at least 3 timestamps,
 * starting at 0:00, in increasing order — the same rule YouTube uses. Each chapter gets its transcript text.
 */
export function chapters(description, segs, videoId, durationSec) {
    const lines = String(description ?? '').split('\n');
    const found = [];
    for (const line of lines) {
        const m = line.match(/^\s*(?:[-•▶►*]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.+?)\s*$/) ?? line.match(/^\s*(.+?)\s*[-–—:|]?\s*\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*$/);
        if (!m) continue;
        const [ts, title] = /\d:\d{2}$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
        const sec = ts.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
        const name = title.replace(/^[-–—:|\s]+/, '').trim();
        if (name) found.push({ sec, title: name });
    }
    if (found.length < 3 || found[0].sec !== 0) return [];
    for (let i = 1; i < found.length; i++) if (found[i].sec <= found[i - 1].sec) return [];
    return found.map((c, i) => {
        const end = found[i + 1]?.sec ?? durationSec ?? Infinity;
        const inside = segs.filter((s) => s.start >= c.sec && s.start < end);
        return { title: c.title, start: c.sec, start_hms: hms(c.sec), end: Number.isFinite(end) ? end : null, url: deepLink(videoId, c.sec), word_count: wordCount(toText(inside)), text: toText(inside) };
    });
}

const norm = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Every place a keyword is said, with the line, a little context and a deep link. */
export function keywordHits(segs, keywords, videoId, maxPerKeyword = 50) {
    const out = [];
    for (const kw of keywords) {
        const k = norm(kw).trim();
        if (!k) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u');
        let n = 0;
        segs.forEach((s, i) => {
            if (n >= maxPerKeyword) return;
            const window = norm([segs[i - 1]?.text, s.text].filter(Boolean).join(' '));
            if (!re.test(norm(s.text)) && !(i > 0 && re.test(window) && !re.test(norm(segs[i - 1].text)))) return;
            n += 1;
            out.push({ keyword: kw, time: s.start, time_hms: hms(s.start), text: s.text, context: toText(segs.slice(Math.max(0, i - 1), i + 2)), url: deepLink(videoId, s.start) });
        });
    }
    return out;
}
