/** @pullboard-test-input source-cell store */
// fixture-subject: createFileWriteQueue (real temp directories and real child processes)
/** The file write queue applies writes across processes in order and keeps each caller's result [C7,#8163]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFileWriteQueue } from '../../src/io/write-queue-file.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runModuleChild as child } from '../fixtures/module-child.js';

const MODULE = fileURLToPath(new URL('../../src/io/write-queue-file.js', import.meta.url));

const WORKER = `
import { appendFileSync } from 'node:fs';
const [dir, log, name, module] = process.argv.slice(1);
const { createFileWriteQueue } = await import(module);
const queue = createFileWriteQueue(dir);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const writes = [];
for (let n = 0; n < 4; n++) {
  writes.push(queue.submit({ id: name + n, run: async () => {
    appendFileSync(log, 'start ' + name + n + '\\n');
    await sleep(30);
    appendFileSync(log, 'end ' + name + n + '\\n');
    return name + n;
  } }));
}
await Promise.all(writes);
`;

test('clause 1: writes submitted to the file queue by two processes against one directory apply one at a time in submission order [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const log = join(dir, 'log.txt');
  appendFileSync(log, '');
  const codes = await Promise.all([child(WORKER, dir, log, 'a', MODULE), child(WORKER, dir, log, 'b', MODULE)]);
  assert.deepEqual(codes, [0, 0]);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 16);
  for (let at = 0; at < lines.length; at += 2) {
    const [, name] = lines[at].split(' ');
    assert.equal(lines[at], `start ${name}`);
    assert.equal(lines[at + 1], `end ${name}`, 'a write started while another was running');
  }
  for (const who of ['a', 'b']) {
    const order = lines.filter(line => line.startsWith('start ' + who)).map(line => line.slice(-1));
    assert.deepEqual(order, ['0', '1', '2', '3'], `${who} writes ran out of submission order`);
  }
  const queue = createFileWriteQueue(dir);
  assert.deepEqual(queue.result('a3'), { ok: true, value: 'a3' });
});

test('clause 2: a caller that dies after submitting finds its write\'s result in the result file when it asks again with the same write id [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const log = join(dir, 'log.txt');
  const dying = `
    import { appendFileSync } from 'node:fs';
    const [dir, log, module] = process.argv.slice(1);
    const { createFileWriteQueue } = await import(module);
    const queue = createFileWriteQueue(dir);
    queue.submit({ id: 'w1', run: () => { appendFileSync(log, 'ran\\n'); setImmediate(() => process.exit(3)); return 42; } });
    await new Promise(() => {});
  `;
  assert.equal(await child(dying, dir, log, MODULE), 3);
  const queue = createFileWriteQueue(dir);
  assert.deepEqual(queue.result('w1'), { ok: true, value: 42 });
  const again = await queue.submit({ id: 'w1', run: () => { appendFileSync(log, 'ran again\n'); return 7; } });
  assert.deepEqual(again, { ok: true, value: 42 });
  assert.equal(readFileSync(log, 'utf8'), 'ran\n');
  assert.equal(queue.result('missing'), null);
});

test('clause 3: a failed write stores its error in its own result file and the writes behind it still apply [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const queue = createFileWriteQueue(dir);
  const order = [];
  const first = queue.submit({ id: 'f1', run: () => { order.push('f1'); return 'one'; } });
  const bad = queue.submit({ id: 'f2', run: () => { order.push('f2'); throw Object.assign(new Error('boom'), { code: 'BOOM' }); } });
  const last = queue.submit({ id: 'f3', run: () => { order.push('f3'); return 'three'; } });
  assert.deepEqual(await first, { ok: true, value: 'one' });
  assert.deepEqual(await bad, { ok: false, error: { code: 'BOOM', message: 'boom' } });
  assert.deepEqual(await last, { ok: true, value: 'three' });
  assert.deepEqual(order, ['f1', 'f2', 'f3']);
  assert.ok(existsSync(join(dir, 'f2.result')));
  assert.deepEqual(queue.result('f2'), { ok: false, error: { code: 'BOOM', message: 'boom' } });
});
