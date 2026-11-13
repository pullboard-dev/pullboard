/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js apps/lib/src/io/worker/checkpoint/relay.js packages/link/index.js packages/outbox/index.js */
/** Legacy API1 refusals recover without blocking moves; current API2 pause proofs live in relay-upload-pause.test.js [H16,B26]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import {
  decodeBoardKey,
  unseal,
} from '../../../../packages/kernel/index.js';
import {
  assertPaused,
  relayClientFixture,
  settleLinkedSubmit,
  uploadedState,
} from '../../tests/fixtures/relay/upload.js';


// The subtests each start their own private relay fixture, so they run side by side: back to back they outlast the file's wall limit on a loaded runner.
test('a refused upload never blocks board moves [H16,B26]', async (t) => {
  const box = await relayClientFixture(t);
  const buildLane = 'fixture-build';
  const gate = 'node --check src/relay-pause-fixture.js';
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = gate;
  config.lanes[buildLane] = { owns: ['src/'], specs: ['G'], starts: 'now' };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const specPath = join(box.root, 'SPEC.md');
  const spec = readFileSync(specPath, 'utf8').replace('\n## K · Constraints',
    `\n- G1 [approved, must] The fixture builder's file parses. | gate: ${gate}\n\n## K · Constraints`);
  writeFileSync(specPath, spec);
  const added = await box.cli('add', buildLane, 'paused relay fixture task', '--specs', 'G1', '--criterion', 'the fixture agent completes this task',
    '--brief', 'Files: src/relay-pause-fixture.js\nTest: the fixture source parses', '--check', gate);
  assert.equal(added.code, 0, `the fixture creates its task; result=${JSON.stringify(added.document)}`);
  const item = added.document.item.item_id;
  box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'fixture refuses the initial baseline until repaired' });
  const linked = await box.link();
  assert.equal((linked.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 1);
  const status = await box.cli('status');
  assert.equal(status.code, 0);
  assertPaused(status.document);
  const pausedLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.deepEqual(Object.keys(pausedLink.baselinePause).sort(), ['code', 'message', 'status'],
    'a small refused baseline persists only its bounded safe diagnostic');
  assert.equal(pausedLink.baselinePause.status, 400);
  assert.ok(pausedLink.baselinePause.message.length <= 240);
  assert.doesNotMatch(JSON.stringify(pausedLink.baselinePause), /(?:ps|pa)_[A-Za-z0-9_-]{20,}/u);
  assert.ok(pausedLink.snapshot, 'refused ciphertext remains durable until a recovered baseline includes all paused local work');
  const diagnosed = await box.cli('doctor');
  assert.ok([0, 1].includes(diagnosed.code));
  assertPaused(diagnosed.document);

  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  const staged = spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const seeded = spawnSync('git', ['commit', '-m', 'chore(test): seed relay pause fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const agentRoot = join(box.root, '..', 'relay-stuck-upload-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-relay-stuck-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);

  const joined = await box.cliAt(agentRoot, 'join', buildLane);
  assert.equal(joined.code, 0);
  assertPaused(joined.document);
  const claimed = await box.cliAt(agentRoot, 'claim', String(item));
  assert.equal(claimed.code, 0, `the linked agent claims locally while no relay baseline exists; result=${JSON.stringify(claimed.document)}`);
  assertPaused(claimed.document);

  mkdirSync(join(agentRoot, 'src'), { recursive: true });
  writeFileSync(join(agentRoot, 'src/relay-pause-fixture.js'), 'export const relayPauseFixture = true;\n');
  const stagedChange = spawnSync('git', ['add', 'src/relay-pause-fixture.js'], { cwd: agentRoot, env: box.env, encoding: 'utf8' });
  assert.equal(stagedChange.status, 0, stagedChange.stderr);
  const committed = spawnSync('git', ['commit', '-m', 'feat(fixture-build): complete relay pause fixture [G1]'], { cwd: agentRoot, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.cliAt(agentRoot, 'submit', String(item));
  assert.equal(submitted.code, 0, 'the linked agent submits locally while the baseline is refused');
  assertPaused(submitted.document);
  await settleLinkedSubmit(t, box, agentRoot, submitted);
  const shouted = await box.cliAt(agentRoot, 'shout', 'all', 'Relay pause fixture remains available');
  assert.equal(shouted.code, 0, 'the linked agent shouts locally while the baseline is refused');
  assertPaused(shouted.document);

  box.rejectSnapshots(null);
  const resumed = await box.cliAt(agentRoot, 'status');
  assert.equal(resumed.code, 0);
  assert.doesNotMatch((resumed.document.diagnostics ?? []).join('\n'), /relay paused/u, 'a fitting snapshot clears the pause');
  // Submit records a background review comparison fact (499990d401); that one native move queues while paused and may follow the baseline.
  const sentOperations = async () => {
    const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
    const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
    return Promise.all(box.moveAcks.map(async row => JSON.parse(new TextDecoder().decode(
      await unseal(key, Buffer.from(row.sealed, 'base64url'), { boardId: board, kind: row.kind, sequence: row.event_id }))).operation));
  };
  assert.deepEqual((await sentOperations()).filter(operation => operation !== 'appendFact'), [],
    'no paused local move was sent before its baseline existed');
  const baseline = await uploadedState(box);
  assert.equal(baseline.sequence, box.moveAcks.length, 'the baseline checkpoint covers only the queued review fact move, if it was sent');
  assert.equal(baseline.document.tables.item.find(row => row.item_id === item).item_status, 'submitted',
    'the accepted fresh baseline includes the local claim and submission');
  assert.ok(baseline.document.tables.shout.some(row => row.shout_text === 'Relay pause fixture remains available'),
    'the fresh baseline retains the local shout');
  assert.ok(baseline.document.tables.agent.some(row => row.agent_path === agentRoot),
    'the fresh baseline retains the locally enrolled agent');
  const ordered = await box.cliAt(agentRoot, 'shout', 'all', 'The relay baseline has resumed');
  assert.equal(ordered.code, 0);
  assert.doesNotMatch((ordered.document.diagnostics ?? []).join('\n'), /relay paused/u);
  const operations = await sentOperations();
  assert.deepEqual(operations.slice(-1), ['shout']);
  assert.deepEqual(box.moveAcks.map(row => row.event_id), operations.map((operation, index) => index + 1),
    'the real relay ACK places the first post-recovery native move immediately after its baseline');
  const final = await uploadedState(box);
  assert.equal(final.sequence, operations.length, 'the native checkpoint covers the post-recovery move');
  assert.ok(final.document.tables.shout.some(row => row.shout_text === 'The relay baseline has resumed'));
});
