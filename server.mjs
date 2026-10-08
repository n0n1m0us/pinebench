#!/usr/bin/env node
// Local TradingView-style backtest UI.  usage: node server.mjs [port=8787]  → http://127.0.0.1:8787
// Strategies: .pine/.txt files dropped in ./strategies (re-scanned on every listing).
// Indicators and OHLC CSVs: found under this folder (e.g. ./data), or under $BT_ROOT if set.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { Indicator } from 'pinets';
import { appendBar, drawingCount, drawingsOf, loadCsv, openScript, runBacktest, summarize } from './backtest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.BT_ROOT ?? HERE);
const STRAT_DIR = join(HERE, 'strategies');
const PORT = +(process.argv[2] ?? 8787);
const CHART_TFS = [1, 5, 15, 30, 60, 240, 1440];
const MAX_CHART_BARS = 300_000;
const DEFAULT_PROPS = { initial_capital: 10_000_000 }; // big enough that 100% margin never blocks entries
const MAX_COMBOS = 2000;
const OVERLAY_LOOKBACK_MS = 7 * 864e5, OVERLAY_MAX_SPAN_MS = 31 * 864e5;

const head = (p) => {
    const fd = openSync(p, 'r'), b = Buffer.alloc(4096);
    const n = readSync(fd, b, 0, 4096, 0);
    closeSync(fd);
    return b.subarray(0, n).toString('utf8');
};

function listFiles() {
    const strategies = [], indicators = [], data = [];
    const walk = (dir, depth) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (depth < 2) walk(p, depth + 1); continue; }
            const ext = extname(e.name).toLowerCase();
            try {
                if (ext === '.pine' || ext === '.txt') {
                    const h = head(p);
                    if (/\bindicator\s*\(/.test(h)) indicators.push(relative(ROOT, p));
                }
                else if (ext === '.csv') {
                    const lines = head(p).split('\n'), h = lines[0].toLowerCase();
                    if (['open', 'high', 'low', 'close'].every((k) => h.includes(k)))
                        data.push({ path: relative(ROOT, p), mb: +(statSync(p).size / 2 ** 20).toFixed(1), asset: /^[A-Za-z]+/.exec(e.name)?.[0].toUpperCase() ?? e.name, tf: barMinutes(e.name, lines) });
                }
            } catch {}
        }
    };
    walk(ROOT, 0);
    // one file per asset + timeframe: the biggest wins (e.g. NQ1_1y.csv is a subset of NQ1_1m_5y.csv)
    const best = new Map();
    for (const d of data) { const k = d.asset + '|' + d.tf; if (!best.has(k) || best.get(k).mb < d.mb) best.set(k, d); }
    data.splice(0, data.length, ...best.values());
    for (const n of readdirSync(STRAT_DIR)) if (/\.(pine|txt)$/i.test(n)) try { if (/\bstrategy\s*\(/.test(head(join(STRAT_DIR, n)))) strategies.push(n); } catch {}
    return { root: ROOT, strategies: strategies.sort(), indicators: indicators.sort(), data: data.sort((a, b) => a.path.localeCompare(b.path)) };
}

// bar size in minutes: from the name (NQ1_5m_5y) or the gap between the first timestamps in the file
function barMinutes(name, lines) {
    const m = /_(\d+)m_/.exec(name);
    if (m) return +m[1];
    const ts = [...new Set(lines.slice(1, -1).map((l) => Date.parse(l.split(',')[0])).filter(Number.isFinite))].sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((g) => g > 0);
    return gaps.length ? Math.round(Math.min(...gaps) / 60_000) : 1;
}

// Only files the listing would show may be read — keeps the API from reading arbitrary paths.
function safePath(rel, kind) {
    const files = listFiles();
    const ok = kind === 'data' ? files.data.some((d) => d.path === rel) : files[kind === 'strategy' ? 'strategies' : 'indicators'].includes(rel);
    if (!ok) throw new Error(`not an allowed ${kind} file: ${rel}`);
    return resolve(kind === 'strategy' ? STRAT_DIR : ROOT, rel);
}

// tz offset (ms) cached per UTC hour; Lightweight Charts has no tz support, so times are shifted.
function tzShifter(tz) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const cache = new Map();
    return (t) => {
        const h = Math.floor(t / 3_600_000);
        let off = cache.get(h);
        if (off === undefined) {
            const p = Object.fromEntries(fmt.formatToParts(h * 3_600_000).map((x) => [x.type, +x.value]));
            off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - h * 3_600_000;
            cache.set(h, off);
        }
        return t + off;
    };
}

// IPDA ids: EA_* = first window of the sequence, EB_* = second → "Long 1", "Sell 2". Other scripts keep their ids.
function entryLabel(t) {
    const w = /^E([A-Z])_/.exec(t.entry_id ?? '');
    return `${t.size > 0 ? 'Long' : 'Sell'} ${w ? w[1].charCodeAt(0) - 64 : t.entry_id}`;
}
function exitLabel(t) {
    const id = t.exit_id ?? '';
    const tp = /_TP(\d)$/.exec(id);
    // TP exits carry a stop leg too (TP1: stop=SL, TP2: stop=entry) — name the leg that actually filled
    if (tp) return (t.exit_price - t.entry_price) * Math.sign(t.size) > 0 ? `TP${tp[1]}` : tp[1] === '1' ? 'SL' : 'BE';
    if (/_SL$/.test(id)) return 'SL';
    if (/^Close position/.test(id)) return 'Rollover';  // strategy.close_all at sequence end
    if (/^Close entry/.test(id)) return 'Time exit';    // strategy.close at window end
    if (/^E[A-Z]_[LS]$/.test(id)) return 'Reversal';    // closed by an opposite entry filling
    return id || 'Exit';
}

function chartData(run, wantTf) {
    const { bars, trades, tz, tf } = run;
    let ctf = Math.max(+wantTf || 1, +tf);
    for (const c of CHART_TFS) if (c >= ctf && bars.length * (+tf / c) <= MAX_CHART_BARS) { ctf = c; break; }
    const step = ctf * 60_000, shift = tzShifter(tz);
    const bucket = (t) => Math.floor(shift(t) / step) * step / 1000; // seconds, tz-shifted
    const candles = [];
    for (const b of bars) {
        const t = bucket(b.openTime), last = candles.at(-1);
        if (last && last.time === t) {
            if (b.high > last.high) last.high = b.high;
            if (b.low < last.low) last.low = b.low;
            last.close = b.close;
        } else candles.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
    }
    const markers = [];
    trades.forEach((t, i) => {
        const long = t.size > 0;
        // placed at the fill price so entries/exits line up with the candle that filled them
        markers.push({ id: `t${i}`, kind: long ? 'long' : 'short', time: bucket(t.entry_time), position: long ? 'atPriceTop' : 'atPriceBottom', price: t.entry_price, shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#4f6f95' : '#a8443a', size: 1.2, text: t.label });
        markers.push({ id: `t${i}`, kind: t.profit >= 0 ? 'win' : 'loss', time: bucket(t.exit_time), position: long ? 'atPriceBottom' : 'atPriceTop', price: t.exit_price, shape: long ? 'arrowDown' : 'arrowUp', color: t.profit >= 0 ? '#2f6b4e' : '#a8443a', size: 1.2, text: `${t.exit_label} ${t.profit >= 0 ? '+' : '-'}$${Math.abs(Math.round(t.profit)).toLocaleString('en-US')}` });
    });
    markers.sort((a, b) => a.time - b.time);
    let eq = 0;
    const equity = [];
    for (const t of [...trades].sort((a, b) => a.exit_time - b.exit_time)) {
        eq += t.profit;
        const time = bucket(t.exit_time);
        if (equity.at(-1)?.time === time) equity.at(-1).value = eq;
        else equity.push({ time, value: eq });
    }
    return { chartTf: ctf, candles, markers, equity };
}

let dataCache = null; // { key, bars }
let lastRun = null;

// Loads CONTEXT_MS of history before `from` too: the chart and the indicator overlay get it (replay opens on a
// drawn chart), the strategy never does — strategyBars() cuts it off so results stay those of [from, to].
const CONTEXT_MS = 10 * 864e5;
async function loadBars(body) {
    const csv = safePath(body.data, 'data');
    const key = JSON.stringify([csv, body.from, body.to, body.symbol, body.tz]);
    if (dataCache?.key !== key) {
        dataCache = null; // free the old set before loading a new one
        const from = body.from ? new Date(Date.parse(body.from) - CONTEXT_MS).toISOString() : undefined;
        const bars = await loadCsv(csv, { from, to: body.to || undefined, symbol: body.symbol || undefined, tz: body.tz });
        if (!bars.length) throw new Error('no bars in that range');
        dataCache = { key, bars };
    }
    return dataCache.bars;
}
const strategyBars = (all, body) => {
    const fromMs = body.from ? Date.parse(body.from) : -Infinity, bars = all.filter((b) => b.openTime >= fromMs);
    if (!bars.length) throw new Error('no bars in that range');
    return bars;
};
const runOpts = (body) => ({ tf: String(body.tf), mintick: body.mintick, pointvalue: body.pointvalue, tz: body.tz, ticker: body.symbol || undefined, props: { ...DEFAULT_PROPS, ...body.props } });

async function handleRun(body) {
    const all = await loadBars(body), bars = strategyBars(all, body);
    if (body.manual) { // chart + indicator only: the strategy never runs, the user places the trades during the replay
        lastRun = { seq: ++runSeq, bars: all, trades: [], tz: body.tz, tf: body.tf, opts: runOpts(body) };
        return { manual: true, info: { bars: bars.length, first: bars[0].openTime, last: bars.at(-1).openTime, seconds: 0, ticker: bars.at(-1).sym, initial_capital: null }, stats: {}, trades: [], ...chartData(lastRun, body.chartTf) };
    }
    const source = body.source ?? readFileSync(safePath(body.strategy, 'strategy'), 'utf8');
    const t0 = Date.now(), log = exitLog();
    const ctx = await runBacktest(source, bars, { ...runOpts(body), inputs: body.inputs, onBar: log.onBar });
    const s = ctx.strategy;
    const trades = s.closedtrades.map((t) => ({ entry_id: t.entry_id, exit_id: t.exit_id, size: t.size, entry_time: t.entry_time, entry_price: t.entry_price, exit_time: t.exit_time, exit_price: t.exit_price, profit: t.profit, commission: t.commission ?? 0 }));
    for (const t of trades) { t.label = entryLabel(t); t.exit_label = exitLabel(t); }
    lastRun = { seq: ++runSeq, bars: all, trades, tz: body.tz, tf: body.tf, opts: runOpts(body) };
    const stats = summarize(s);
    stats['avg trade'] = trades.length ? s.netprofit / trades.length : NaN;
    stats['commission paid'] = trades.reduce((a, t) => a + t.commission, 0);
    return {
        info: { bars: bars.length, first: bars[0].openTime, last: bars.at(-1).openTime, seconds: (Date.now() - t0) / 1000, ticker: bars.at(-1).sym, initial_capital: s.initial_capital },
        stats, trades, exits: log.done(), ...chartData(lastRun, body.chartTf),
    };
}

// Pending exit orders (TP limit / SL stop) over time, for the replay's order lines: one row per order level,
// live from the bar it was placed (t0) until the bar it filled or was cancelled / replaced (t1, null = never).
function exitLog() {
    const live = new Map(), out = [];
    return {
        onBar(c, time) {
            const seen = new Set();
            for (const o of c.strategy?.pending_orders ?? []) {
                if (o.status !== 'pending' || o.category !== 'exit') continue;
                const k = [o.id, o.from_entry, o.limit, o.stop].join('|');
                seen.add(k);
                if (!live.has(k)) live.set(k, { id: o.id, entry_id: o.from_entry, limit: o.limit ?? null, stop: o.stop ?? null, t0: time, t1: null });
            }
            for (const [k, e] of live) if (!seen.has(k)) { e.t1 = time; out.push(e); live.delete(k); }
        },
        done: () => [...out, ...live.values()],
    };
}

// ── indicator overlay: run the indicator over [view - lookback, view end] of the last run's bars.
// Times in/out are chart seconds (tz-shifted, like chartData). timenow → last_bar_time so
// live-only indicators (current sequence picked by timenow, drawn on barstate.islast) replay as of the view.
// Replay (body.live) asks again every candle and a full run takes ~1.2 s. Appending a closed bar to a kept run costs ~1 ms,
// but the script's output depends on the whole history as of the last bar (timenow → last_bar_time, barstate.islast), and its
// live sequence rollover leaves a different state than a fresh run would. The rollover always changes the number of
// lines/labels, so there the run starts over from scratch (see drawingCount). Replay bars are known ahead, so a worker
// pool runs this over the next stretch of bars while the replay plays and requests are answered from that cache; an
// answer can be for a slightly earlier candle (`behind`, the client shifts it and asks again). A cold miss runs here.
const OV_CHUNK_MIN = 12 * 60, OV_AHEAD = 3, OV_POOL = Math.max(1, Math.min(3, availableParallelism() - 2)); // jobs of 12 h of bars, 36 h ahead
let ovSess = null, ovAhead = null, runSeq = 0;
const ovChunk = () => Math.max(24, Math.round(OV_CHUNK_MIN / lastRun.tf));

function prefetch(key, src, opts, i0, i1, ctfMs) {
    const { bars, tf } = lastRun, shift = tzShifter(lastRun.tz), CH = ovChunk(), end = Math.min(bars.length, i1 - 1 + CH * OV_AHEAD);
    if (ovAhead?.key !== key) {
        ovAhead?.pool.forEach((p) => p.w.terminate());
        ovAhead = { key, out: new Map(), jobs: [], pool: [], seq: 0 };
    }
    const a = ovAhead;
    for (const k of a.out.keys()) if (k < i1 - CH || k > end + CH + 1) a.out.delete(k); // jobs run up to CH past `end`
    // a job [s, e) posts the drawings as of every bar k in it (key k + 1). Cancel what the replay passed or what starts
    // too late in history for this view, then queue the stretches of [i1 - 1, end) nobody covers.
    for (const j of a.jobs) if (j.e < i1 || j.w0 > i0) {
        j.dead = true;
        if (j.p) Atomics.store(j.p.ctl, 0, 0); // the worker stops at its next bar
    }
    a.jobs = a.jobs.filter((j) => !j.dead);
    for (let x = i1 - 1; x < end;) {
        const on = a.jobs.find((j) => j.s <= x && x < j.e);
        if (on) { x = on.e; continue; }
        const next = Math.min(bars.length, x + CH, ...a.jobs.filter((j) => j.s > x).map((j) => j.s)); // full-size jobs, not 1-bar slivers at the edge
        a.jobs.push({ s: x, e: next, w0: i0 });
        x = next;
    }
    const pump = (p) => {
        const j = a.jobs.filter((j) => !j.p && !j.done).sort((u, v) => u.s - v.s)[0];
        p.job = j;
        if (!j) return;
        j.p = p;
        // only the states the client can ask for: the last bar of each chart candle
        const want = [], bucket = (k) => Math.floor(shift(bars[k].openTime) / ctfMs);
        for (let k = j.s; k < j.e; k++) if (k + 1 >= bars.length || bucket(k) !== bucket(k + 1)) want.push(k - j.w0);
        Atomics.store(p.ctl, 0, (j.id = ++a.seq));
        p.w.postMessage({ id: j.id, src, opts, tfMs: +tf * 60_000, bars: bars.slice(j.w0, j.e), from: j.s - j.w0, want });
    };
    while (a.pool.length < OV_POOL) {
        // ponytail: 256 MB heap fits a 31-day view + lookback of 1m bars (~120 MB); raise it if workers report out-of-memory
        const ctl = new Int32Array(new SharedArrayBuffer(4)); // id of the job the worker should be running
        const p = { ctl, w: new Worker(new URL('./ov-worker.mjs', import.meta.url), { workerData: { ctl }, resourceLimits: { maxOldGenerationSizeMb: 256 } }) };
        p.w.on('message', (m) => {
            const j = p.job;
            if (ovAhead !== a || !j) return;
            if (m.error) console.error('overlay prefetch:', m.error);
            if (m.d && !j.dead) a.out.set(j.w0 + m.i + 1, { i0: j.w0, d: m.d });
            if (m.done) { j.done = true; j.p = null; pump(p); }
        });
        p.w.on('error', (e) => { // e.g. out of memory: drop this worker, its job goes back in the queue
            console.error('overlay prefetch worker:', e.message);
            if (p.job) p.job.p = null;
            a.pool.splice(a.pool.indexOf(p), 1);
        });
        a.pool.push(p);
        pump(p);
    }
    for (const p of a.pool) if (!p.job) pump(p);
}

async function overlay(body) {
    if (!lastRun) throw new Error('run a backtest first');
    const src = readFileSync(safePath(body.indicator, 'indicator'), 'utf8').replace(/\btimenow\b/g, 'last_bar_time');
    const fromMs = body.from * 1000, toMs = body.to * 1000;
    if (toMs - fromMs > OVERLAY_MAX_SPAN_MS) throw new Error('zoom in (≤ 31 days visible) to draw the indicator');
    const { bars, tf, tz } = lastRun, shift = tzShifter(tz);
    const first = (pred) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pred(bars[m])) hi = m; else lo = m + 1; } return lo; };
    const i0 = first((b) => shift(b.openTime) >= fromMs - OVERLAY_LOOKBACK_MS), i1 = first((b) => shift(b.openTime) > toMs);
    if (i1 - i0 < 2) return { lines: [], boxes: [], labels: [] };
    const opts = { ...lastRun.opts, props: {}, inputs: body.inputs ?? {} }, key = JSON.stringify([lastRun.seq, src, opts.inputs, body.ctf]);
    let d, behind = 0;
    if (body.live) { // newest prefetched state at or before i1; the client shifts it by `behind` bars and asks again
        prefetch(key, src, opts, i0, i1, (body.ctf || +tf) * 60_000);
        for (; behind < ovChunk() && !d; behind++) { const hit = ovAhead.out.get(i1 - behind); if (hit && hit.i0 <= i0) d = hit.d; }
        behind = d ? behind - 1 : 0;
    }
    if (!d) {
        let s = ovSess;
        const reuse = body.live && s?.key === key && s.i0 <= i0 && s.i1 <= i1 && i1 - s.i1 <= 24;
        if (reuse) while (s.i1 < i1) {
            const n = drawingCount(s.ctx);
            await appendBar(s, bars[s.i1++]);
            if (drawingCount(s.ctx) !== n) { s.i1 = -1; break; } // rollover code ran: start over below
        }
        if (!reuse || s.i1 !== i1) s = ovSess = { key, i0, i1, ...(await openScript(src, bars.slice(i0, i1), opts)) };
        d = drawingsOf(s, +tf * 60_000);
    }
    const T = (ms) => shift(ms) / 1000;
    return {
        lines: d.lines.map((l) => ({ ...l, x1: T(l.x1), x2: T(l.x2) })),
        boxes: d.boxes.map((b) => ({ ...b, x1: T(b.x1), x2: T(b.x2) })),
        labels: d.labels.map((l) => ({ ...l, x: T(l.x) })),
        behind,
    };
}

// ── optimizer: cartesian grid of input values, run on a worker pool (one copy of the bars per worker)
let job = null;
async function optimize(body) {
    if (job?.running) throw new Error('an optimization is already running');
    const params = (body.params ?? []).filter((p) => p.values?.length);
    if (!params.length) throw new Error('tick at least one input to optimize');
    let combos = [{}];
    for (const p of params) combos = combos.flatMap((c) => p.values.map((v) => ({ ...c, [p.varId]: v })));
    if (combos.length > MAX_COMBOS) throw new Error(`${combos.length} combinations — max ${MAX_COMBOS}, use bigger steps`);
    const source = body.source ?? readFileSync(safePath(body.strategy, 'strategy'), 'utf8');
    const bars = strategyBars(await loadBars(body), body);
    // ponytail: memory model measured on PineTS (~2.2 KB/bar); 8 GB budget across workers
    const perWorkerMb = Math.max(1024, Math.ceil((bars.length * 2.2e3 * 1.5) / 2 ** 20));
    const n = Math.max(1, Math.min(combos.length, availableParallelism() - 2, Math.floor(8192 / perWorkerMb), 6));
    const j = (job = { running: true, total: combos.length, done: 0, workers: n, params, started: Date.now(), results: [], errors: 0, pool: [] });
    let next = 0;
    const finish = () => { j.running = false; j.ended = Date.now(); j.pool.forEach((w) => w.terminate()); };
    for (let k = 0; k < n; k++) {
        const w = new Worker(new URL('./opt-worker.mjs', import.meta.url), { workerData: { source, bars, opts: runOpts(body) }, resourceLimits: { maxOldGenerationSizeMb: perWorkerMb } });
        const feed = () => { if (j.running && next < combos.length) { const i = next++; w.postMessage({ i, inputs: { ...body.inputs, ...combos[i] } }); } };
        w.on('message', (m) => {
            if (!j.running) return;
            j.done++;
            if (m.error) { j.errors++; j.lastError = m.error; } else j.results.push({ i: m.i, values: combos[m.i], stats: m.stats });
            if (j.done === j.total) finish(); else feed();
        });
        w.on('error', (e) => { j.lastError = String(e.message ?? e); finish(); });
        j.pool.push(w);
        feed();
    }
    return status();
}
const status = () => job && { running: job.running, total: job.total, done: job.done, workers: job.workers, errors: job.errors, lastError: job.lastError, params: job.params, seconds: ((job.ended ?? Date.now()) - job.started) / 1000, results: job.results };

function meta(body) {
    const source = body.source ?? readFileSync(safePath(body.strategy, 'strategy'), 'utf8');
    const ind = new Indicator(source);
    return { inputs: ind.getInputsMeta() };
}

const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
};
const readBody = (req) => new Promise((ok, fail) => {
    let s = '';
    req.on('data', (c) => (s += c)).on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
});

createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
        if (url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html' });
            return res.end(readFileSync(join(HERE, 'index.html')));
        }
        if (url.pathname === '/lwc.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            return res.end(readFileSync(join(HERE, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));
        }
        if (url.pathname === '/lucide.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            return res.end(readFileSync(join(HERE, 'node_modules/lucide/dist/umd/lucide.min.js')));
        }
        if (url.pathname === '/api/files') return json(res, 200, listFiles());
        if (req.method === 'POST' && url.pathname === '/api/meta') return json(res, 200, meta(await readBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/run') return json(res, 200, await handleRun(await readBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/overlay') return json(res, 200, await overlay(await readBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/optimize') return json(res, 200, await optimize(await readBody(req)));
        if (url.pathname === '/api/optimize') return json(res, 200, status());
        if (req.method === 'POST' && url.pathname === '/api/optimize/stop') { if (job?.running) { job.running = false; job.ended = Date.now(); job.pool.forEach((w) => w.terminate()); } return json(res, 200, status()); }
        if (url.pathname === '/api/chart') {
            if (!lastRun) throw new Error('run a backtest first');
            return json(res, 200, chartData(lastRun, url.searchParams.get('tf')));
        }
        json(res, 404, { error: 'not found' });
    } catch (e) {
        console.error(e.message);
        json(res, 400, { error: String(e.message ?? e).slice(0, 2000) });
    }
}).listen(PORT, '127.0.0.1', () => console.log(`backtest UI → http://127.0.0.1:${PORT}  (files under ${ROOT})`));
