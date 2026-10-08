// One optimizer worker: holds the bars once, runs one input combination per message.
import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest, summarize } from './backtest.mjs';

const { source, bars, opts } = workerData;
parentPort.on('message', async ({ i, inputs }) => {
    try {
        const s = (await runBacktest(source, bars, { ...opts, inputs })).strategy;
        parentPort.postMessage({ i, stats: { ...summarize(s), 'avg trade': s.closedtrades.length ? s.netprofit / s.closedtrades.length : NaN } });
    } catch (e) {
        parentPort.postMessage({ i, error: String(e.message ?? e).slice(0, 300) });
    }
});
