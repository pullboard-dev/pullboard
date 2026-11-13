/** The board API restarts onto new code without refusing a request: the new process takes the old one's listening socket first [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { restartOnCodeMove } from '../../../drive/index.js';
import { handoffFd } from '../../src/io/handoff.js';
import { listenOn } from '../../src/io/handoff.js';

const HANDOFF = new URL('../../src/io/handoff.js', import.meta.url).href;

/** One request on its own connection: the body, or the error that refused it. */
function get(port) {
  return new Promise(resolve => {
    const call = request({ host: '127.0.0.1', port, agent: false, timeout: 2_000 }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body)); });
    call.on('error', error => resolve(`ERR ${error.code}`));
    call.on('timeout', () => call.destroy(new Error('timeout')));
    call.end();
  });
}

test('clause 1: a child that inherits the listening socket answers while the old server closes, so no request is refused [C7]', { timeout: 60_000 }, async t => {
  const old = createServer((_, res) => res.end('old'));
  await new Promise(done => old.listen(listenOn({ port: 0, address: '127.0.0.1' }), done));
  const { port } = old.address();
  const fd = handoffFd(old);
  assert.ok(Number.isInteger(fd), 'a listening server names its descriptor');
  const script = `const { createServer } = await import('node:http'); const { listenOn } = await import(${JSON.stringify(HANDOFF)});
    createServer((_, res) => res.end('new')).listen(listenOn({ port: 0, address: '127.0.0.1', fd: 3 }), () => process.send('listening'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'inherit', 'inherit', fd, 'ipc'] });
  t.after(() => child.kill());
  const replies = [];
  let running = true;
  const hammer = (async () => { while (running) { replies.push(await get(port)); } })();
  await new Promise((done, fail) => { child.once('message', done); child.once('exit', code => fail(new Error(`child exited ${code}`))); });
  await new Promise(done => { old.close(done); old.closeIdleConnections(); });
  const closedAt = replies.length;
  while (replies.length < closedAt + 30) await get(port).then(reply => replies.push(reply));
  running = false;
  await hammer;
  assert.deepEqual(replies.filter(reply => reply !== 'old' && reply !== 'new'), [], 'every request through the restart was answered');
  assert.ok(replies.includes('old') && replies.at(-1) === 'new', 'the old server answered first, the new one last');
});

test('clause 1: a restart with handoff starts the new process before the old one closes [C7]', async () => {
  const order = [];
  let revision = 'a'.repeat(40);
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true, log: () => {},
    close: async () => { order.push('close'); }, relaunch: async () => { order.push('relaunch'); return { pid: 1 }; } });
  revision = 'b'.repeat(40);
  const alive = setInterval(() => {}, 1_000); // the restart's own timer is unref'd, so something must keep this process up
  const moved = await fresh.restarted;
  clearInterval(alive);
  fresh.stop();
  assert.deepEqual(order, ['relaunch', 'close'], 'the new process listens first');
  assert.equal(moved.pid, 1);
});

test('clause 1: without handoff a restart still closes before it relaunches [C7]', async () => {
  const order = [];
  let revision = 'a'.repeat(40);
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, log: () => {},
    close: async () => { order.push('close'); }, relaunch: async () => { order.push('relaunch'); return { pid: 2 }; } });
  revision = 'b'.repeat(40);
  const alive = setInterval(() => {}, 1_000);
  await fresh.restarted;
  clearInterval(alive);
  fresh.stop();
  assert.deepEqual(order, ['close', 'relaunch']);
});
