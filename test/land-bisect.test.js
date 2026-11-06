/** Independently schedule the real red landing bisection [B3,R3,E8]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { calls, events, json, onBoard } from './land-board-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('land bisects a real red, blocks stale proof and refuses an unverified stack [B3,R3,E8]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries.slice(0, 3)) submitItem(box, entry, entry === entries[2] ? 'RED\n' : 'PASS\n');
  const hidden = itemWorktree(box, 5, 'web/unverified.js');
  assert.equal(commitFile(box, hidden.path, hidden.file, '// unverified\n', 'feat(web): unverified ancestor [G1]').status, 0);
  const hiddenSha = box.git(hidden.path, 'rev-parse', 'HEAD');
  box.git(entries[3].path, 'merge', '--no-ff', hiddenSha, '-m', 'feat(web): include ancestor [G1]');
  submitItem(box, entries[3]);
  for (const entry of entries) acceptItem(box, entry);
  assert.equal(box.run(hidden.path, 'submit', String(hidden.item), '--no-next').code, 0);
  delete box.env.LAND_SUPPRESS_RED;
  assert.equal(commitFile(box, box.repo, FILES[1], 'different main content\n', 'chore: create a merge conflict').status, 0);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const beforeEvents = events(box).length;
  const beforeCalls = calls(box).length;
  const dry = json(box, box.repo, 'land', '--max', '4', '--dry-run');
  assert.deepEqual(dry.conflicts, [], 'main changed the reviewed path, so stale proof is blocked before attempting its merge');
  assert.deepEqual(dry.blocked, [
    { id: entries[1].item, code: 'STALE_VERDICT', file: FILES[1], commit: base,
      reviewedTrunk: entries[1].reviewedTrunk, main: base },
    { id: entries[3].item, code: 'STACKED_UNVERIFIED', stacked: hidden.item },
  ]);
  assert.equal(events(box).length, beforeEvents, 'dry run creates no board batch');
  assert.equal(calls(box).length, beforeCalls, 'dry run runs no gate');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed, [entries[0].item]);
  assert.deepEqual(result.conflicts, dry.conflicts);
  assert.deepEqual(result.blocked, dry.blocked);
  assert.deepEqual(result.culprits.map((entry) => entry.id), [entries[2].item]);
  const evidence = result.batch.invariantEvidence;
  assert.equal(evidence.version, 1);
  const failedGate = evidence.gates.find(gate => !gate.isGreen);
  assert.match(failedGate.commit, /^[a-f0-9]{40}$/u, 'the actual gate records its tested commit, not only a tree');
  assert.ok(failedGate.submissions.some(row => row.id === entries[2].item && row.commit === entries[2].commit));
  assert.ok(failedGate.failures.includes(FILES[2]));
  const diagnosis = evidence.diagnostics.find(row => row.test === FILES[2]);
  assert.equal(diagnosis.commit, failedGate.commit, 'the whole-file diagnosis names the exact original merge');
  assert.equal(diagnosis.isGreen, false);
  assert.equal(typeof diagnosis.wallMs, 'number', 'runtime is the real queued diagnostic execution wall');
  assert.ok(diagnosis.wallMs >= 0);
  assert.equal(result.culprits[0].tests[0].file, FILES[2]);
  assert.match(result.culprits[0].tests[0].name, /keeps the landed behavior/u);
  assert.ok(json(box, box.repo, 'show', String(entries[2].item)).thread.some((entry) => entry.type === 'fact' && entry.text.includes(FILES[2])));
  // A bisection round now runs only the failed file (the './' form), so the rounds are single-file runs between the two full trees.
  const ran = calls(box).slice(beforeCalls);
  assert.deepEqual([ran[0], ran.at(-1)], [[], []], 'the red batch and the final tree run whole: returning its culprit changes badge counts, so that different tree needs its own gate');
  const alone = ran.slice(1, -1);
  assert.ok(alone.length > 0 && alone.every(call => call[0] === '--alone' && [FILES[2], `./${FILES[2]}`].includes(call[1])), `only the failed file ran between the two full trees: ${JSON.stringify(alone)}`);
  assert.equal(alone.filter(call => call[1] === FILES[2]).length, 1, 'exactly one whole-file diagnostic; the other runs are failed-case rounds');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, result.batch.tip);
  for (const entry of entries.slice(1)) assert.equal(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.notEqual(result.batch.tip, base);
  const afterCalls = calls(box).length;
  const beforeEmptyEvents = events(box);
  const beforeEmptyLease = onBoard(box, board => store.landingLeaseState(board));
  const idleState = JSON.stringify(onBoard(box, board => ({ batches: store.landingBatches(board).map(b => [b.state, b.base, b.tip]), lease: store.landingLeaseState(board) })));
  const again = box.run(box.repo, 'land', '--json');
  assert.equal(again.code, 1, again.out + again.err);
  assert.equal(JSON.parse(again.out).error.code, 'STALE_VERDICT', 'an all-blocked queue refuses instead of suggesting an empty successful land');
  assert.deepEqual(events(box), beforeEmptyEvents, `an idle all-blocked selection adds no lease events: ${idleState} trunk ${box.git(box.repo, 'rev-parse', 'main')} ${existsSync(join(box.repo, '.git', 'landtrace.log')) ? readFileSync(join(box.repo, '.git', 'landtrace.log'), 'utf8') : 'NO TRACE'}`);
  assert.deepEqual(onBoard(box, board => store.landingLeaseState(board)), beforeEmptyLease, 'a stale refusal takes no lease');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).item_status, 'open', 'the known red is returned to its builder and is no longer a verified landing candidate');
  assert.equal(calls(box).length, afterCalls, 'known unchanged red is not retried');
});

