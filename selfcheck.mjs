// node selfcheck.mjs — fails if CSV roll logic or PineTS strategy wiring breaks
import assert from 'node:assert';
import { frontMonth } from './backtest.mjs';
import { PineTS } from 'pinets';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resample } from './resample.mjs';

const d = Date.UTC(2025, 0, 2);
const r = (t, sym, volume) => ({ openTime: t, open: 1, high: 1, low: 1, close: 1, volume, sym });
const out = frontMonth([r(d + 60e3, 'A', 5), r(d, 'B', 50), r(d, 'A', 5), r(d + 864e5, 'A', 9)]);
assert.deepStrictEqual(out.map((x) => x.sym), ['B', 'A']); // day1 → B (more volume), day2 → A

const bars = Array.from({ length: 30 }, (_, i) => ({ openTime: d + i * 60e3, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
const ctx = await new PineTS(bars).run(`//@version=6
strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long, 1)
if bar_index == 11
    strategy.close("L")
`);
assert.strictEqual(ctx.strategy.closedtrades.length, 1);
assert.strictEqual(ctx.strategy.netprofit, 10); // fill next open: 102 → 112
// resample: rows out of order, two contracts, one 5m bucket each
const dir = mkdtempSync(join(tmpdir(), 'rs-'));
writeFileSync(join(dir, 'in.csv'), `ts_event,open,high,low,close,volume,symbol
2025-01-02T00:01:00Z,11,13,10,12,2,A
2025-01-02T00:00:00Z,10,11,9,11,1,A
2025-01-02T00:04:00Z,12,12,8,9,3,A
2025-01-02T00:02:00Z,50,51,49,50,7,B
`);
const rs = await resample(join(dir, 'in.csv'), join(dir, 'out.csv'), 5);
assert.strictEqual(rs.volIn, rs.volOut);
assert.deepStrictEqual(readFileSync(join(dir, 'out.csv'), 'utf8').trim().split('\n').slice(1), [
    '2025-01-02T00:00:00.000Z,10,13,8,9,6,A', // open from 00:00, close from 00:04
    '2025-01-02T00:00:00.000Z,50,51,49,50,7,B',
]);
console.log('ok');
