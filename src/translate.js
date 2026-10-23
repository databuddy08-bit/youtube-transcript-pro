// Translation: YouTube's own caption translation first (keeps timings); Google Translate as a fallback when YouTube throttles it.
import { gotScraping } from 'got-scraping';

const GTX = process.env.GTX_BASE ?? 'https://translate.googleapis.com';

/** Translates lines in batches, keeping one output line per input line. Returns null if alignment can't be kept. */
export async function translateLines(lines, target, { stats } = {}) {
    const out = [];
    let batch = [];
    let size = 0;
    const flush = async () => {
        if (!batch.length) return true;
        const q = batch.join('\n');
        let res;
        for (let a = 0; a < 3; a++) {
            try {
                res = await gotScraping({
                    url: `${GTX}/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t`,
                    method: 'POST', body: new URLSearchParams({ q }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    responseType: 'json', throwHttpErrors: false, retry: { limit: 0 }, timeout: { request: 20000 },
                });
                if (stats) stats.translateRequests = (stats.translateRequests ?? 0) + 1;
                if (res.statusCode === 200) break;
            } catch { /* retry */ }
            await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
        }
        if (res?.statusCode !== 200 || !Array.isArray(res.body?.[0])) return false;
        const translated = res.body[0].map((p) => p?.[0] ?? '').join('').split('\n');
        if (translated.length !== batch.length) return false;
        out.push(...translated.map((t) => t.trim()));
        batch = [];
        size = 0;
        return true;
    };
    for (const line of lines) {
        const l = line.replace(/\n/g, ' ');
        if (size + l.length > 3500 && !(await flush())) return null;
        batch.push(l);
        size += l.length + 1;
    }
    if (!(await flush())) return null;
    return out;
}
