#!/usr/bin/env node
// Resample a 1m OHLCV CSV to N minutes, per contract (symbol column kept, spreads included).
// usage: node resample.mjs <in.csv> <out.csv> [minutes=5]
// Buckets are floor(time / N min) in UTC — same boundaries TradingView uses for 5/15/30/60m.
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseTime } from './backtest.mjs';

export async function resample(inFile, outFile, minutes = 5) {
    const step = minutes * 60_000;
    const buckets = new Map(); // `${sym}|${bucket}` → [t, o, h, l, c, v, sym]
    let col, rowsIn = 0, volIn = 0;
    for await (const line of createInterface({ input: createReadStream(inFile) })) {
        if (!line.trim()) continue;
        const f = line.split(',');
        if (!col) {
            const h = f.map((x) => x.trim().toLowerCase());
            col = Object.fromEntries(['open', 'high', 'low', 'close', 'volume', 'symbol'].map((k) => [k, h.indexOf(k)]));
            col.time = h.findIndex((x) => ['ts_event', 'time', 'timestamp', 'datetime', 'date'].includes(x));
            continue;
        }
        const t = parseTime(f[col.time]);
        const sym = col.symbol >= 0 ? f[col.symbol] : '';
        const o = +f[col.open], hi = +f[col.high], lo = +f[col.low], c = +f[col.close], v = col.volume >= 0 ? +f[col.volume] : 0;
        const bt = Math.floor(t / step) * step;
        const key = sym + '|' + bt;
        const b = buckets.get(key);
        rowsIn++; volIn += v;
        if (!b) buckets.set(key, [bt, o, hi, lo, c, v, sym, t, t]);
        else {
            // input order isn't guaranteed per symbol → track first/last minute explicitly
            if (t < b[7]) { b[1] = o; b[7] = t; }
            if (t >= b[8]) { b[4] = c; b[8] = t; }
            if (hi > b[2]) b[2] = hi;
            if (lo < b[3]) b[3] = lo;
            b[5] += v;
        }
    }
    const rows = [...buckets.values()].sort((a, b) => a[0] - b[0] || (a[6] < b[6] ? -1 : 1));
    const out = createWriteStream(outFile);
    out.write('ts_event,open,high,low,close,volume,symbol\n');
    let volOut = 0;
    for (const [t, o, h, l, c, v, sym] of rows) {
        out.write(`${new Date(t).toISOString()},${o},${h},${l},${c},${v},${sym}\n`);
        volOut += v;
    }
    await new Promise((r) => out.end(r));
    return { rowsIn, rowsOut: rows.length, volIn, volOut, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [inFile, outFile, m = '5'] = process.argv.slice(2);
    if (!inFile || !outFile) { console.error('usage: node resample.mjs <in.csv> <out.csv> [minutes=5]'); process.exit(1); }
    const r = await resample(inFile, outFile, +m);
    const bad = r.rows.filter(([, o, h, l, c]) => h < Math.max(o, c) || l > Math.min(o, c)).length;
    console.log(`1m rows ${r.rowsIn} → ${m}m rows ${r.rowsOut}; volume in ${r.volIn} out ${r.volOut}; OHLC violations ${bad}`);
    if (r.volIn !== r.volOut || bad) process.exit(2);
}
