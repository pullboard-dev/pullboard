/** Measure a real relay read while its reused socket closes during a blocked client event loop. */
import { Worker } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
import { setImmediate as turn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { request } from '../../../index.js';

const serverSource = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { createServer } from 'node:http';
const flag = new Int32Array(workerData.flag);
const sockets = new Set();
let last, resetting, connections = 0, requests = 0, resets = 0, mutations = 0;
/** Signal physical socket closure while the client's event loop cannot consume its own close event. */
function closed() { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }
const server = createServer(async (req, res) => {
  requests++;
  if (req.method !== 'GET') { for await (const chunk of req) { /* Consume the real write body before applying its counted effect. */ } mutations++; }
  if (requests > 1 && (workerData.mode === 'always-reset' || workerData.mode === 'write-reset')) {
    resets++; req.socket.resetAndDestroy(); return;
  }
  if (requests > 1 && workerData.mode === 'http-refusal') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 1, error: { code: 'FIXTURE_REFUSAL', message: 'controlled refusal' } })); return;
  }
  if (requests > 1 && workerData.mode === 'body-invalid') { res.end('invalid-json'); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ version: 1, request: requests }));
});
server.on('connection', socket => {
  connections++; last = socket; sockets.add(socket);
  socket.on('error', () => { /* The diagnostic intentionally resets only this owned socket. */ });
  socket.on('close', () => { sockets.delete(socket); if (resetting === socket) closed(); });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', async message => {
  if (message === 'reset') {
    resetting = last;
    if (!last || last.destroyed) closed();
    else { resets++; if (workerData.closeKind === 'fin') last.destroy(); else last.resetAndDestroy(); }
  }
  if (message === 'finish') {
    parentPort.postMessage({ connections, requests, resets, mutations });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    parentPort.close();
  }
});
`;

/** Bound an owned worker message wait and fail if its thread exits before replying. */
function messageFrom(worker) {
  return new Promise((resolve, reject) => {
    /** Remove every listener and timer on either terminal outcome. */
    const finish = (error, value) => { clearTimeout(timer); worker.off('message', reply); worker.off('error', fail); worker.off('exit', exit); error ? reject(error) : resolve(value); };
    /** Deliver the worker's private fixture receipt. */
    const reply = value => finish(null, value);
    /** Preserve a real worker failure. */
    const fail = error => finish(error);
    /** Refuse an incomplete fixture protocol instead of hanging after thread exit. */
    const exit = code => finish(new Error('fixture worker exited before its reply: ' + code));
    const timer = setTimeout(() => finish(new Error('fixture worker reply deadline expired')), 5000); // budget: hang ceiling for fixture startup or shutdown, not a throughput assertion.
    worker.once('message', reply); worker.once('error', fail); worker.once('exit', exit);
  });
}

const nativeFetch = globalThis.fetch;

/** Run one independent local server, changing only how the same closed connection is treated. */
export async function relayResetSample(mode = 'stale', { round = 1, closeKind = 'rst', method = 'GET' } = {}) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(serverSource)), { workerData: { flag: flag.buffer, closeKind, mode } });
  const { port } = await messageFrom(worker);
  const origin = 'http://127.0.0.1:' + port;
  const sends = [], signals = [];
  const cancellation = new AbortController();
  const trace = channel('undici:client:sendHeaders');
  /** Keep only this fixture's socket identities; credentials and headers never enter the trace. */
  const record = ({ socket }) => { if (socket.remotePort === port) sends.push(socket); };
  trace.subscribe(record);
  const creates = [], connects = [], errors = [];
  /** Count this fixture's real request creations without recording addresses or credentials. */
  const created = ({ request }) => { if (String(request.origin) === origin) creates.push({ method: request.method }); };
  /** Count newly connected sockets independently of sent headers. */
  const connected = ({ socket }) => { if (socket.remotePort === port) connects.push(socket); };
  /** Record only socket error codes and optionally cancel at the actual failure boundary. */
  const failed = ({ request, error }) => { if (String(request.origin) === origin) { errors.push({ code: error.code }); if (mode === 'abort-reset') cancellation.abort(new Error('controlled cancellation')); } };
  channel('undici:request:create').subscribe(created);
  channel('undici:client:connected').subscribe(connected);
  channel('undici:request:error').subscribe(failed);
  /** Preserve the real fetch transport while observing signals or removing pooling in one control. */
  globalThis.fetch = (url, init = {}) => {
    if (new URL(url).origin === origin) signals.push(init.signal);
    if (mode !== 'fresh') return nativeFetch(url, init);
    const headers = new Headers(init.headers); headers.set('connection', 'close');
    return nativeFetch(url, { ...init, headers });
  };
  let result;
  try {
    await request({ url: origin }, '/api/v1/boards/fixture/events?after=0', {}, { ignoreRelayEnvironmentToken: true, err() {} });
    await turn();
    const warm = sends[0];
    const warmClosed = mode === 'processed' && warm && !warm.destroyed ? new Promise(resolve => warm.once('close', resolve)) : null;
    let blockedMs = 0;
    if (!['write-reset', 'http-refusal', 'body-invalid'].includes(mode)) {
      worker.postMessage('reset');
      const blocked = performance.now();
      const wait = Atomics.wait(flag, 0, 0, 2000); // budget: hang ceiling for the independent worker's physical close acknowledgement.
      if (wait === 'timed-out') throw new Error('worker did not confirm the controlled close');
      blockedMs = performance.now() - blocked;
      if (mode === 'processed' && warm && !warm.destroyed) await warmClosed;
    }
    const socketBeforeRead = warm ? { destroyed: warm.destroyed, writable: warm.writable, readable: warm.readable, bytesWritten: warm.bytesWritten } : null;
    const started = performance.now();
    try {
      const document = await request({ url: origin }, '/api/v1/boards/fixture/events?after=0', { method, ...(method === 'GET' ? {} : { body: { effect: 'once' } }), ...(mode === 'abort-reset' ? { signal: cancellation.signal } : {}) }, { ignoreRelayEnvironmentToken: true, err() {} });
      result = { mode, round, success: true, documentVersion: document.version };
    } catch (error) {
      result = { mode, round, success: false, code: error.code, transportFailure: error.transportFailure };
    }
    result.closeKind = closeKind;
    result.elapsedMs = performance.now() - started;
    result.blockedMs = blockedMs;
    result.clientSends = sends.length;
    result.sameSocketSecondHeaders = sends.length > 1 ? sends[1] === warm : null;
    result.socketBeforeRead = socketBeforeRead;
    result.requestCreates = creates.length;
    result.connectedSockets = connects.length;
    result.requestErrors = errors;
    result.readAttempts = signals.length - 1;
    result.sameReadSignal = signals.slice(1).every(signal => signal === signals[1]);
    const finished = messageFrom(worker);
    const exited = new Promise(resolve => worker.once('exit', resolve));
    worker.postMessage('finish');
    [result.server] = await Promise.all([finished, exited]);
    return result;
  } finally {
    globalThis.fetch = nativeFetch;
    trace.unsubscribe(record);
    channel('undici:request:create').unsubscribe(created);
    channel('undici:client:connected').unsubscribe(connected);
    channel('undici:request:error').unsubscribe(failed);
    await worker.terminate();
  }
}
