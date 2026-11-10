// @pullboard-test-loads packages/link/src/io/relay.js apps/cli/src/io/entry.js
/** A transport canary proves relay acknowledgment even when ordinary writes are local first [H21,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outboxFile } from '../../../../../packages/outbox/index.js';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';

const CLI = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
const RELAY = new URL('../../../../../packages/link/index.js', import.meta.url).href;
const POLICY = new URL('../../../index.js', import.meta.url).href;
const OPENERS = new URL('../../../tests/fixtures/board.js', import.meta.url).href;

/** Commit the actual absent-setting default before real device sign-in; no environment-token shortcut is used. */
async function linkedBoard(t) {
  t.diagnostic(JSON.stringify({ node: process.version, host: hostname(), execPath: process.execPath,
    binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const box = await relayClientFixture(t);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config.relay) delete config.relay.outbox;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'chore(config): exercise default canary policy'], { cwd: box.root, env: box.env });
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(state.baselineAccepted, true);
  assert.ok(state.agentTokens?.coordinator, 'the fixture has a genuine saved agent credential');
  assert.equal(Object.hasOwn(config.relay ?? {}, 'outbox'), false);
  assert.equal(box.env.PULLBOARD_RELAY_TOKEN, undefined);
  return box;
}

/** Call the exported real transport seam in a fixture child; the future CLI flag producer is not simulated. */
function move(box, text, relayCanary) {
  const source = `
    const { relayOperation } = await import(${JSON.stringify(RELAY)});
    const { cli$relayOutboxSetting: relayOutboxSetting } = await import(${JSON.stringify(POLICY)});
    const { apiBoardOpeners } = await import(${JSON.stringify(OPENERS)});
    const root = process.cwd();
    const io = { ...apiBoardOpeners, err() {}, relayCanary: ${JSON.stringify(relayCanary)}, relayOutbox: () => relayOutboxSetting(root) };
    try {
      const result = await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text: ${JSON.stringify(text)} }], io);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })); }
  `;
  return runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, env: box.env });
}

/** Read native fixture records without invoking sync or a write-capable board opener. */
function records(box) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try { return { events: db.prepare('SELECT * FROM event ORDER BY event_id').all(), shouts: db.prepare('SELECT shout_text FROM shout ORDER BY shout_id').all() }; }
  finally { db.close(); }
}

/** Decode only the safe result wrapper, preserving transport refusals as data for the assertions. */
function outcome(result) {
  assert.equal(result.status, 0, result.context);
  return JSON.parse(result.stdout);
}

test('a local-first transport canary waits for a real acknowledgment while an ordinary move remains local [H21,H16]', async t => {
  const box = await linkedBoard(t);
  let markReached, release;
  const reached = new Promise(resolve => { markReached = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  box.beforeNextMove(async () => { markReached(); await response; });
  const acknowledgments = box.moveAcks.length;
  const probeText = 'A canary must reach the relay';
  const probe = move(box, probeText, true);
  let result;
  try {
    const first = await Promise.race([reached.then(() => 'server'), probe.then(() => 'closed')]);
    assert.equal(first, 'server', 'a local-first canary cannot return before reaching the real relay');
    assert.equal(probe.child.exitCode, null, 'the canary remains pending until its held relay response is released');
    assert.equal(box.moveAcks.length, acknowledgments, 'the relay has not acknowledged the held canary yet');
    const ordinaryText = 'An ordinary move remains local beside a canary';
    assert.equal(outcome(await move(box, ordinaryText, false)).ok, true);
    assert.ok(records(box).shouts.some(row => row.shout_text === ordinaryText), 'the ordinary move exists locally while the relay response is held');
    assert.equal(existsSync(outboxFile(box.linkFile)), true, 'the ordinary move retains its durable outbox');
    assert.equal(probe.child.exitCode, null, 'an ordinary local move does not release the canary response');
  } finally { release(); result = await probe; }
  assert.equal(outcome(result).ok, true);
  assert.ok(box.moveAcks.length > acknowledgments, 'the held canary response completes a genuine relay acknowledgment');
  assert.equal(records(box).shouts.filter(row => row.shout_text === probeText).length, 1, 'the acknowledged canary is replayed locally exactly once');
});

test('an unavailable relay refuses a canary without recording or queueing it [H21,H16]', async t => {
  const box = await linkedBoard(t);
  const before = records(box);
  await box.stopRelay();
  const result = outcome(await move(box, 'An unavailable canary must not become local work', true));
  assert.equal(result.ok, false, 'a transport outage cannot turn a canary into an unacknowledged local success');
  assert.ok(['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(result.code), 'the canary preserves its genuine transport refusal');
  assert.deepEqual(records(box), before, 'a refused canary changes no native event or shout');
  assert.equal(existsSync(outboxFile(box.linkFile)), false, 'a canary cannot use the transient-failure outbox fallback');
});
