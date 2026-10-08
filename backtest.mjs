#!/usr/bin/env node
// Backtest a Pine Script strategy on a local OHLCV CSV with PineTS.
// usage: node backtest.mjs <strategy.pine> <data.csv> [--tf 1] [--mintick 0.25] [--pointvalue 20]
//        [--tz America/New_York] [--symbol NQU5] [--from 2025-01-01] [--to 2025-06-01] [--trades trades.csv]
//        [--prop initial_capital=1e7] [--prop margin_long=10] [--input "TP1 TICKS=200"]   (repeatable)
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Indicator, PineTS } from 'pinets';

// PineTS builds a fresh Intl.DateTimeFormat on every tz lookup (hour(), time(), … per bar) and construction dominates
// run time. Formatters are immutable, so hand back one shared instance per (locale, options).
const DTF = Intl.DateTimeFormat, dtfCache = new Map();
Intl.DateTimeFormat = Object.assign(function DateTimeFormat(locale, opts) {
    const k = JSON.stringify([locale, opts]);
    let f = dtfCache.get(k);
    if (!f) dtfCache.set(k, (f = new DTF(locale, opts)));
    return f;
}, { prototype: DTF.prototype, supportedLocalesOf: DTF.supportedLocalesOf });

const TIME_COLS = ['ts_event', 'time', 'timestamp', 'datetime', 'date', 'opentime', 'open_time'];
export const parseTime = (s) => {
    if (/^\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        return n < 1e11 ? n * 1000 : n > 1e14 ? Math.floor(n / 1e6) : n; // sec | ns | ms
    }
    return Date.parse(s.replace(/(\.\d{3})\d+/, '$1')); // trim ns fractions (Databento)
};

// Stream so multi-GB files work; --from/--to filter while reading.
export async function loadCsv(file, { symbol, from, to, tz } = {}) {
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const rows = [];
    let col;
    for await (const line of createInterface({ input: createReadStream(file) })) {
        if (!line.trim()) continue;
        const f = line.split(',');
        if (!col) {
            const h = f.map((x) => x.trim().toLowerCase());
            col = Object.fromEntries(['open', 'high', 'low', 'close', 'volume', 'symbol'].map((k) => [k, h.indexOf(k)]));
            col.time = h.findIndex((x) => TIME_COLS.includes(x));
            if (col.time < 0 || [col.open, col.high, col.low, col.close].includes(-1))
                throw new Error(`CSV needs a time column (${TIME_COLS}) + open,high,low,close. Got: ${h}`);
            continue;
        }
        const t = parseTime(f[col.time]);
        if (!(t >= fromMs && t < toMs)) continue;
        const sym = col.symbol >= 0 ? f[col.symbol] : '';
        if (symbol ? sym !== symbol : sym.includes('-')) continue; // drop calendar spreads
        rows.push({ openTime: t, open: +f[col.open], high: +f[col.high], low: +f[col.low], close: +f[col.close], volume: col.volume >= 0 ? +f[col.volume] : 0, sym });
    }
    return frontMonth(rows, tz);
}

// Multiple contracts in one file → per local (tz) day keep the highest-volume contract.
// ponytail: volume-based daily roll, no back-adjustment; price gaps at rolls remain.
export function frontMonth(rows, tz = 'UTC') {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const vol = new Map();
    for (const r of rows) {
        r.key = day.format(r.openTime) + '|' + r.sym;
        vol.set(r.key, (vol.get(r.key) ?? 0) + r.volume);
    }
    const best = new Map();
    for (const [k, v] of vol) {
        const [day] = k.split('|');
        if (!best.has(day) || v > vol.get(best.get(day))) best.set(day, k);
    }
    const out = rows.filter((r) => best.get(r.key.split('|')[0]) === r.key);
    out.sort((a, b) => a.openTime - b.openTime);
    return out.filter((r, i) => i === 0 || r.openTime !== out[i - 1].openTime);
}

// Transpiling a 1k-line script costs ~170 ms per run. The transpiled fn holds no run state, so share it per source.
const prepCache = new Map();
function indicatorFor(source, inputs) {
    const ind = new Indicator(source, inputs), p = prepCache.get(source);
    if (p) ind._prepared = { ...p, get inputs() { return ind.getRuntimeInputs(); } };
    else { const { fn, usesVisibleRange, ltfSlices } = ind.prepare(); prepCache.set(source, { fn, usesVisibleRange, ltfSlices }); }
    return ind;
}

// Run any script (indicator or strategy) over pre-loaded bars.
export async function runScript(source, bars, opts) {
    return (await openScript(source, bars, opts)).ctx;
}

// Same, but also hands back the PineTS instance so the caller can append bars to the run (see server.mjs overlay).
// onBar(ctx, barOpenTime) runs after every bar (the run then steps one bar at a time).
export async function openScript(source, bars, { tf = '1', mintick = 0.01, pointvalue = 1, tz = 'America/New_York', ticker, inputs = {}, props = {}, onBar } = {}) {
    ticker ??= bars.at(-1)?.sym || 'CSV';
    // Minimal provider (not a raw array) so syminfo.mintick / timezone reach the script.
    const provider = {
        configure() {},
        async getMarketData(_t, reqTf) {
            if (reqTf !== tf) throw new Error(`request.security(${reqTf}) not supported: CSV has only tf=${tf}`);
            return bars.slice(); // a copy: openScript callers append to the run
        },
        async getSymbolInfo() {
            return { ticker, tickerid: ticker, root: ticker, type: 'futures', currency: 'USD', timezone: tz, session: '24x7', mintick: +mintick, minmove: 1, pricescale: Math.round(1 / +mintick), pointvalue: +pointvalue, mincontract: 1 };
        },
    };
    const ind = indicatorFor(source, inputs);
    Object.assign(ind.prop, props);
    const pt = new PineTS(provider, ticker, tf);
    if (onBar) {
        const step = pt._executeIterations.bind(pt);
        pt._executeIterations = async (c, code, from, to) => { for (let a = from; a < to; a++) { await step(c, code, a, a + 1); onBar(c, pt.data[a].openTime); } };
    }
    return { pt, ctx: await pt.run(ind) };
}

// Feed one more closed bar to a run from openScript (no rollback: bars must arrive in order and never change).
export async function appendBar({ pt, ctx }, bar) {
    pt._appendCandle(bar);
    ctx.length = pt.data.length;
    await pt._executeIterations(ctx, pt._transpiledCode, ctx.length - 1, ctx.length);
}

const liveDrawings = (ctx, k) => (ctx.plots?.[k]?.data?.at(-1)?.value ?? []).filter((d) => !d._deleted);
// Line + label counts. A replay run that appends bars restarts from scratch when these change: on a heavy indicator that is
// exactly where its live sequence rollover runs and drifts from a fresh run (1100-bar test: 3/3 drifts; the 28 new-HTF-window
// box additions never drifted, so box counts are left out).
export const drawingCount = (ctx) => ['__lines__', '__labels__'].map((k) => liveDrawings(ctx, k).length).join();

// A run's lines / boxes / labels with x as epoch ms (bar_index x's past the last bar are projected at tfMs steps).
export function drawingsOf({ pt, ctx }, tfMs) {
    const bars = pt.data, lastT = bars.at(-1).openTime;
    const X = (x, xloc) => (xloc === 'bi' ? (x < bars.length ? bars[Math.max(0, x)].openTime : lastT + (x - bars.length + 1) * tfMs) : x);
    return {
        lines: liveDrawings(ctx, '__lines__').map((l) => ({ x1: X(l.x1, l.xloc), y1: l.y1, x2: X(l.x2, l.xloc), y2: l.y2, extend: l.extend, color: l.color, style: l.style, width: l.width })),
        boxes: liveDrawings(ctx, '__boxes__').map((b) => ({ x1: X(b.left, b.xloc), x2: X(b.right, b.xloc), top: b.top, bottom: b.bottom, bg: b.bgcolor, border: b.border_color, width: b.border_width, text: b.text, textColor: b.text_color })),
        labels: liveDrawings(ctx, '__labels__').map((l) => ({ x: X(l.x, l.xloc), y: l.y, text: l.text, style: l.style, color: l.color, textColor: l.textcolor, size: l.size })),
    };
}

// Run a strategy over pre-loaded bars. Shared by the CLI, server.mjs and opt-worker.mjs.
export async function runBacktest(source, bars, opts) {
    const ctx = await runScript(source, bars, opts);
    if (!ctx.strategy) throw new Error('script declared no strategy() — nothing to report');
    return ctx;
}

export function summarize(s) {
    const trades = s.closedtrades;
    const wins = trades.filter((t) => t.profit > 0).length;
    return {
        'net profit': s.netprofit,
        'gross profit': s.grossprofit,
        'gross loss': s.grossloss,
        'profit factor': s.grossprofit / Math.abs(s.grossloss),
        'closed trades': trades.length,
        'win rate %': (wins / trades.length) * 100,
        'max drawdown': s.max_drawdown,
        'open trades': s.opentrades.length,
        'open profit': s.openprofit,
        sharpe: s.sharpe_ratio,
        sortino: s.sortino_ratio,
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values: opt, positionals: [pineFile, csvFile] } = parseArgs({
        allowPositionals: true,
        options: {
            tf: { type: 'string', default: '1' },
            mintick: { type: 'string', default: '0.01' },
            pointvalue: { type: 'string', default: '1' },
            tz: { type: 'string', default: 'America/New_York' },
            symbol: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            trades: { type: 'string' },
            prop: { type: 'string', multiple: true, default: [] },
            input: { type: 'string', multiple: true, default: [] },
        },
    });
    if (!pineFile || !csvFile) {
        console.error('usage: node backtest.mjs <strategy.pine> <data.csv> [options]  (see header of backtest.mjs)');
        process.exit(1);
    }

    const bars = await loadCsv(csvFile, opt);
    if (!bars.length) throw new Error('no bars after filtering');
    console.log(`bars: ${bars.length}  ${new Date(bars[0].openTime).toISOString()} → ${new Date(bars.at(-1).openTime).toISOString()}`);

    // "k=v" → { k: v }, numbers/booleans coerced. --input keys are input titles/varIds, --prop keys strategy() params.
    const kv = (list) => Object.fromEntries(list.map((x) => {
        const i = x.indexOf('=');
        const v = x.slice(i + 1);
        return [x.slice(0, i), v === 'true' ? true : v === 'false' ? false : v !== '' && !isNaN(v) ? +v : v];
    }));
    const t0 = Date.now();
    const ctx = await runBacktest(readFileSync(pineFile, 'utf8'), bars, { ...opt, ticker: opt.symbol, inputs: kv(opt.input), props: kv(opt.prop) });
    const s = ctx.strategy;
    const fmt = (n) => (Number.isInteger(n) ? n : Number.isFinite(n) ? n.toFixed(2) : n);
    console.table({ ...Object.fromEntries(Object.entries(summarize(s)).map(([k, v]) => [k, fmt(v)])), 'runtime s': ((Date.now() - t0) / 1000).toFixed(1) });

    if (opt.trades) {
        const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
        const lines = ['entry_id,exit_id,side,size,entry_time,entry_price,exit_time,exit_price,profit,commission'];
        for (const t of s.closedtrades)
            lines.push([t.entry_id, t.exit_id, t.size > 0 ? 'long' : 'short', Math.abs(t.size), iso(t.entry_time), t.entry_price, iso(t.exit_time), t.exit_price, t.profit, t.commission ?? 0].join(','));
        writeFileSync(opt.trades, lines.join('\n') + '\n');
        console.log(`trades → ${opt.trades}`);
    }
}
