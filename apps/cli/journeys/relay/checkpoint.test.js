/** @pullboard-test-input source-tree */
/** A move sends only its own event; one background publisher sends the checkpoint once moves go quiet [H5]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  CHECKPOINT_BACKGROUND_ENV,
  CHECKPOINT_QUIET_ENV,
  scheduleCheckpoint,
} from '../../../../packages/outbox/index.js';

/** Whether a relay call uploads a checkpoint: an API1 state write or an API2 page publish. */
function checkpointUpload(call) {
  return call.method === 'PUT' && /^\/api\/v1\/boards\/[0-9a-f]{32}\/state$/u.test(call.path ?? '')
    || call.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(call.path ?? '');
}

/** Wait until the background publisher has uploaded at least `uploads` checkpoints since `from` and finished. */
async function publisherDone(box, from, uploads) {
  const directory = dirname(box.linkFile);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (box.calls.slice(from).filter(checkpointUpload).length >= uploads && !existsSync(join(directory, 'relay-checkpoint.pid'))) return;
    await new Promise(next => setTimeout(next, 100));
  }
  const log = join(directory, 'relay-checkpoint.log');
  const seen = ['relay-checkpoint.due', 'relay-checkpoint.pid'].filter(name => existsSync(join(directory, name)));
  const settings = Object.keys(box.env).filter(name => /^PULLBOARD_RELAY|^NODE_OPTIONS$|^CI$/u.test(name));
  assert.fail(`the background publisher sent no checkpoint: ${existsSync(log) ? readFileSync(log, 'utf8') : 'no publisher log'}; files: ${seen.join(', ') || 'none'}; child settings named: ${settings.join(', ') || 'none'}`);
}

test('a move on a large board sends only its event and never the checkpoint [H5]', async (t) => {
  // The runner keeps checkpoints inside commands, like the view; this case opts in to the background publisher.
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  // A CLI child takes about a second to start, so a burst of them is modelled as moves under three seconds apart.
  process.env[CHECKPOINT_QUIET_ENV] = '3000';
  t.after(() => {
    if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline;
    delete process.env[CHECKPOINT_QUIET_ENV];
  });
  const box = await relayClientFixture(t);

  // Seed the presentation's heaviest part, as on the 22 Oct board: 20,000 shouts.
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  const insert = db.prepare('INSERT INTO shout(shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let index = 0; index < 20_000; index += 1) insert.run('coordinator', 'all', `seeded shout ${index} with some ordinary words in it`, new Date(Date.UTC(2026, 9, 22, 0, 0, index % 60)).toISOString());
  db.exec('COMMIT');
  db.close();
  await box.link();

  // One move, then let its checkpoint go out, so the burst below starts from a covered board.
  const warm = box.calls.length;
  assert.equal((await box.cliLocal('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  const before = box.calls.length;
  for (let index = 1; index <= 10; index += 1) {
    const from = box.calls.length;
    const started = performance.now();
    const moved = await box.cliLocal('shout', 'all', `burst ${index}`);
    const elapsed = performance.now() - started;
    assert.equal(moved.code, 0, JSON.stringify(moved.document));
    const sent = box.calls.slice(from);
    assert.equal(sent.filter(checkpointUpload).length, 0, `move ${index} uploaded no checkpoint`);
    const bytes = sent.reduce((total, call) => total + (call.requestBytes ?? 0), 0);
    assert.ok(bytes < 64 * 1024, `move ${index} sent ${bytes} bytes, under 64 KB`);
    assert.ok(elapsed < 1000, `move ${index} returned in ${Math.round(elapsed)} ms, under one second`); // budget: declared by #1014's bar: a move returns in under one second.
  }
  await publisherDone(box, before, 1);
  await new Promise(next => setTimeout(next, 4_000)); // budget: a second quiet period, so a second upload would show.
  assert.equal(box.calls.slice(before).filter(checkpointUpload).length, 1, 'ten moves in a burst produced one checkpoint upload');
});

test('a move during a held checkpoint upload returns before the upload ends [H5]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cliLocal('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // The relay holds the next checkpoint upload; a move meanwhile must not wait for it.
  box.holdPublishes(true);
  t.after(() => box.holdPublishes(false));
  const from = box.calls.length;
  assert.equal((await box.cliLocal('shout', 'all', 'starts the held upload')).code, 0);
  const deadline = Date.now() + 15_000;
  while (box.heldPublishes() === 0 && Date.now() < deadline) await new Promise(next => setTimeout(next, 50));
  assert.equal(box.heldPublishes(), 1, 'the publisher\'s upload is in flight and held');
  const started = performance.now();
  const moved = await box.cliLocal('shout', 'all', 'moves during the held upload');
  const elapsed = performance.now() - started;
  assert.equal(moved.code, 0, JSON.stringify(moved.document));
  assert.equal(box.heldPublishes(), 1, 'the move returned while the upload was still held');
  assert.ok(elapsed < 2000, `the move took ${Math.round(elapsed)} ms; it must not wait for the upload`); // budget: ceiling for one CLI move with headroom, far under the held upload.
  box.holdPublishes(false);
  await publisherDone(box, from, 2);
});

test('publishers that find a dead holder\'s claim together upload one checkpoint between them [H5]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  process.env[CHECKPOINT_BACKGROUND_ENV] = '0'; // This case starts its publishers itself.
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('shout', 'all', 'a move whose checkpoint is due')).code, 0);
  const directory = dirname(box.linkFile);
  // A claim left by a publisher that died, and a move older than the quiet period.
  writeFileSync(join(directory, 'relay-checkpoint.pid'), '999999\n');
  writeFileSync(join(directory, 'relay-checkpoint.due'), `${Date.now() - 60_000}\n`);
  const from = box.calls.length;
  const worker = fileURLToPath(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url));
  const exits = Array.from({ length: 4 }, () => new Promise(done => {
    spawn(process.execPath, [worker, box.root, box.linkFile], { cwd: box.root, env: box.env, stdio: 'ignore' }).once('exit', done);
  }));
  await Promise.all(exits);
  assert.equal(box.calls.slice(from).filter(checkpointUpload).length, 1, 'four publishers recovering one dead claim sent one checkpoint');
  assert.equal(existsSync(join(directory, 'relay-checkpoint.pid')), false, 'the claim is released');
});

test('a spec edit with no move reaches the next checkpoint, and an idle command uploads none [H5,H16]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cliLocal('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // Nothing changed: the publisher reads the board, finds the page the relay already has, and uploads nothing.
  const idle = box.calls.length;
  assert.equal((await box.cliLocal('status')).code, 0);
  await new Promise(next => setTimeout(next, 4_000)); // budget: declared quiet period plus a read, so an upload would show.
  assert.equal(box.calls.slice(idle).filter(checkpointUpload).length, 0, 'an idle command re-sent no unchanged page');

  // A draft spec row changes only the presentation; the next command's check sends it within a few seconds.
  writeFileSync(join(box.root, 'SPEC.md'), '# Checkpoint fixture spec\n\n## G · Goals\n\n- G1 [draft, must] SPEC_ONLY_CHECKPOINT_1014 | gate: review\n');
  const edited = box.calls.length;
  const started = Date.now();
  assert.equal((await box.cliLocal('status')).code, 0);
  await publisherDone(box, edited, 1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `the spec edit reached a checkpoint in ${elapsed} ms`); // budget: ceiling from the review: a presentation-only change goes out within five seconds.
});

test('a move returns while the publisher asks whether an upload pause is over [H5,H17]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cliLocal('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // A size pause from an earlier refused upload; the publisher's next pass first asks the relay if it is over.
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  link.checkpointRefusal = { code: 'BAD_REQUEST', message: 'the snapshot exceeds the size limit', status: 413, size: true };
  writeFileSync(box.linkFile, JSON.stringify(link));
  box.holdProbes(true);
  const release = setTimeout(() => box.holdProbes(false), 10_000); // budget: ceiling: a held probe ends well after the move's limit.
  t.after(() => { clearTimeout(release); box.holdProbes(false); });
  const from = box.calls.length;
  assert.equal((await box.cliLocal('status')).code, 0);
  const deadline = Date.now() + 15_000;
  while (box.heldProbes() === 0 && Date.now() < deadline) await new Promise(next => setTimeout(next, 50));
  assert.equal(box.heldProbes(), 1, 'the publisher\'s pause probe is in flight and held');
  const started = performance.now();
  const moved = await box.cliLocal('shout', 'all', 'moves during the held probe');
  const elapsed = performance.now() - started;
  assert.equal(moved.code, 0, JSON.stringify(moved.document));
  assert.equal(box.heldProbes(), 1, 'the move returned while the probe was still held');
  assert.ok(elapsed < 2000, `the move took ${Math.round(elapsed)} ms; it must not wait for the probe`); // budget: ceiling for one CLI move with headroom, far under the held probe.
  box.holdProbes(false);
  await publisherDone(box, from, 1);
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpointRefusal, undefined, 'the ended pause is cleared');
});


test('checkpoint scheduling executes the supplied process worker with its exact board arguments [H5,C7]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-checkpoint-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'relay.json');
  const observed = join(root, 'spawned.json');
  const worker = join(root, 'supplied-worker.mjs');
  writeFileSync(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));`);
  assert.throws(() => scheduleCheckpoint(root, file), /requires its process worker path/u);
  assert.equal(existsSync(join(root, 'relay-checkpoint.due')), false, 'a missing port starts no partial scheduling');
  scheduleCheckpoint(root, file, worker);
  const deadline = Date.now() + 10_000;
  while (!existsSync(observed) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), [root, file], 'the actual spawned worker receives the original board and link');
  assert.ok(Number(readFileSync(join(root, 'relay-checkpoint.due'), 'utf8')) > 0, 'the move remains recorded for the publisher');
});

test('importing the checkpoint process entry does not start a publisher [H5,C7]', async () => {
  await assert.doesNotReject(() => import('../../../lib/src/io/worker/checkpoint/relay.js'), 'only invoking the worker file may read process board arguments or publish');
});
