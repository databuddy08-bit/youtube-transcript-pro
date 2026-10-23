// HTTP client: network routes with automatic fallback, rate limiting, YouTube bot-check detection, retries.
import { gotScraping } from 'got-scraping';
import { log } from 'apify';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class BlockedError extends Error {}
export class StoppedError extends Error {}

class RateLimiter {
    constructor(perMinute) {
        this.interval = 60000 / perMinute;
        this.next = 0;
    }

    async wait() {
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.interval;
        if (slot > now) await sleep(slot - now);
    }
}

export class Session {
    constructor() {
        this.rotate();
    }

    rotate() {
        this.id = `s${Math.random().toString(36).slice(2, 12)}`;
    }
}

const BOT_RE = /confirm you.{0,3}re not a bot|unusual traffic|google\.com\/sorry|recaptcha/i;

export class Client {
    /** @param routes ordered [{label, proxy}] — proxy undefined = the server's own IP */
    constructor({ routes, msLeft, stats }) {
        // Playbook rates: 400/min through a proxy (new IP per session), 60/min from the server's own IP.
        const scale = Number(process.env.HTTP_RATE_SCALE ?? 1) || 1;
        this.routes = routes.map((r) => ({ ...r, ok: 0, fail: 0, streak: 0, limiter: new RateLimiter((r.proxy ? 400 : 60) * scale) }));
        this.routeIdx = 0;
        this.msLeft = msLeft;
        this.stats = stats;
    }

    get route() {
        return this.routes[this.routeIdx];
    }

    routeResult(idx, ok) {
        const r = this.routes[idx];
        if (ok) {
            r.ok += 1;
            r.streak = 0;
            return;
        }
        r.fail += 1;
        r.streak += 1;
        const dead = (r.ok === 0 && r.fail >= 5) || r.streak >= 10;
        if (dead && idx === this.routeIdx && this.routeIdx < this.routes.length - 1) {
            this.routeIdx += 1;
            this.stats.routeSwitches = (this.stats.routeSwitches ?? 0) + 1;
            log.warning(`YouTube keeps blocking "${r.label}" (${r.ok} ok / ${r.fail} blocked). Switching to "${this.route.label}".`);
        }
    }

    routesSummary() {
        return this.routes.map((r, i) => ({ route: r.label, used: i <= this.routeIdx, ok: r.ok, blocked: r.fail, active: i === this.routeIdx }));
    }

    /**
     * One request with retries on blocks (new IP each time; the route switches if it keeps failing).
     * @param {{url:string, method?:string, json?:object, body?:any, headers?:object, responseType?:'text'|'buffer', isBlocked?:(res)=>string|null, attempts?:number}} o
     * @returns {Promise<{status:number, body:any, headers:object, url:string}>}
     */
    async fetch(o, session) {
        const attempts = o.attempts ?? (this.route.proxy ? 4 : 3);
        let last = 'unknown';
        let restarts = 0;
        for (let a = 0; a < attempts; a++) {
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            const idx = this.routeIdx;
            const route = this.routes[idx];
            await route.limiter.wait();
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            this.stats.requests += 1;
            let res;
            try {
                res = await gotScraping({
                    url: o.url,
                    method: o.method ?? (o.json ? 'POST' : 'GET'),
                    ...(o.json ? { json: o.json } : {}),
                    ...(o.body !== undefined ? { body: o.body } : {}),
                    headers: o.headers ?? {},
                    useHeaderGenerator: Boolean(o.browserHeaders),
                    proxyUrl: route.proxy ? await route.proxy.newUrl(session.id) : undefined,
                    responseType: o.responseType ?? 'text',
                    followRedirect: o.followRedirect ?? true,
                    throwHttpErrors: false,
                    retry: { limit: 0 },
                    timeout: { request: o.timeoutMs ?? 25000 },
                });
            } catch (err) {
                this.stats.networkErrors += 1;
                last = `network error ${err.code || err.message}`;
                this.routeResult(idx, false);
                session.rotate();
                await sleep(route.proxy ? 800 : 2000 * 2 ** a);
                continue;
            }
            const body = res.body;
            const text = typeof body === 'string' ? body : '';
            // Bot-check text is only looked for in HTML pages: a transcript or description can legitimately say "recaptcha".
            const isHtml = /text\/html/i.test(res.headers['content-type'] ?? '') || /^\s*<(!doctype|html)/i.test(text);
            const blockReason = res.statusCode === 429 || res.statusCode === 403 && !o.allow403 ? `HTTP ${res.statusCode}`
                : (isHtml && BOT_RE.test(text.slice(0, 4000))) || /google\.com\/sorry/.test(res.url) ? 'YouTube bot check ("confirm you\'re not a bot")'
                    : o.isBlocked?.(res) ?? null;
            if (blockReason && o.soft) throw new BlockedError(blockReason); // optional extra (e.g. YouTube translation): don't hurt the route
            if (blockReason) {
                this.stats.blocked += 1;
                last = blockReason;
                this.routeResult(idx, false);
                session.rotate();
                if (this.routeIdx !== idx && restarts < this.routes.length) { // route changed: fresh budget on the new route
                    restarts += 1;
                    a = -1;
                    continue;
                }
                await sleep(route.proxy ? 800 + Math.random() * 400 : Math.min(30000, 2000 * 2 ** a));
                continue;
            }
            if (res.statusCode >= 500) {
                last = `HTTP ${res.statusCode}`;
                await sleep(1500);
                continue;
            }
            this.routeResult(idx, true);
            return { status: res.statusCode, body, headers: res.headers, url: res.url };
        }
        throw new BlockedError(last);
    }
}
