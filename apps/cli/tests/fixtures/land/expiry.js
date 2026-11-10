/** Component integration: real separate-batch operations with injected clock/lease seams, not CLI or ordered-worker lease proof. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';

/** Native fixtures create, submit and independently accept the real red item while suppression is on. */
export function assertLocalWaiverExpiry({ landProject, itemWorktree, submitItem, acceptItem }, seam) {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: exercise local waiver expiry');
  box.env.LAND_SUPPRESS_RED = '1';
  const entry = itemWorktree(box, 1);
  submitItem(box, entry, 'RED\n');
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'main');
  const remote = box.git(box.remote, 'rev-parse', 'main');
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/src/io/main.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, seam, itemId, file] = process.argv.slice(1);',
    'let now = Date.now(); const until = now + 60000; let expired = false, trunkSaved = false, finished = false;',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"), { now: () => new Date(now) });',
    'const expire = () => { now = until; expired = true; };',
    'try {',
    'store.recordLandingWaiver(board, { agentId: "person", channel: "terminal", id: "local-expiry", test: file, until: new Date(until).toISOString(), reason: "private expiry control" });',
    'const write = async (operation, args) => {',
    '  const result = board.enginePorts.store[operation](board, ...args);',
    '  if (operation === "recordLandingBatch" && args[0].batch.state === "trunk") { trunkSaved = true; if (seam === "trunk-save") expire(); }',
    '  if (operation === "finishLandingBatch") finished = true;',
    '  await Promise.resolve(); return result;',
    '};',
    'const checkLease = async () => { await Promise.resolve(); if (trunkSaved && seam === "finish-lease") expire(); };',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: () => {}, checkLease, checkLeaseNow: () => {} }); } catch (failure) { error = failure.code ?? String(failure); }',
    'const batch = store.landingBatches(board).at(-1); const item = store.getItem(board, Number(itemId));',
    'console.log(JSON.stringify({ error, expired, trunkSaved, finished, batch, merged: item.item_merged_commit, mainMoved: store.events(board).filter(row => row.event_kind === "main-moved").length }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const env = { ...box.env };
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, seam, String(entry.item), entry.file], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.trunkSaved, true, 'the actual complete red reached native trunk save with a live waiver');
  assert.ok(result.batch.proof.failures.length > 0, 'waived red never becomes an empty-failure green proof');
  assert.ok(result.batch.proof.failures.every(failure => failure.waiver === 'local-expiry'));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remote, 'separate mode does not publish');
  if (seam === 'live') {
    assert.equal(result.error, null);
    assert.equal(result.finished, true);
    assert.equal(result.batch.state, 'landed');
    assert.ok(result.merged);
    assert.equal(result.mainMoved, 1);
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  } else {
    assert.equal(result.expired, true, 'the injected clock reached the exact expiry boundary');
    assert.equal(result.error, 'LAND_WAIVER');
    assert.equal(result.finished, false, 'no canonical finish call is made after expiry');
    assert.equal(result.merged, null);
    assert.equal(result.mainMoved, 0);
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), base, 'expired authorization cannot fast-forward main');
  }
}
