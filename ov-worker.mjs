// Overlay prefetch for replay: runs the indicator over upcoming bars and posts its drawings as of each `want`ed bar.
// Same rule as server.mjs: append bars, run from scratch again wherever drawingCount changes.
import { parentPort, workerData } from 'node:worker_threads';
import { appendBar, drawingCount, drawingsOf, openScript } from './backtest.mjs';

const { ctl } = workerData; // the server sets ctl[0] to another id to cancel the running job
parentPort.on('message', async ({ id, src, opts, tfMs, bars, from, want }) => {
    const post = new Set(want);
    try {
        let s = await openScript(src, bars.slice(0, from + 1), opts);
        if (post.has(from)) parentPort.postMessage({ i: from, d: drawingsOf(s, tfMs) });
        for (let k = from + 1; k < bars.length && Atomics.load(ctl, 0) === id; k++) {
            const n = drawingCount(s.ctx);
            await appendBar(s, bars[k]);
            if (drawingCount(s.ctx) !== n) s = await openScript(src, bars.slice(0, k + 1), opts);
            if (post.has(k)) parentPort.postMessage({ i: k, d: drawingsOf(s, tfMs) });
        }
    } catch (e) { parentPort.postMessage({ error: String(e.message ?? e) }); }
    parentPort.postMessage({ done: true });
});
