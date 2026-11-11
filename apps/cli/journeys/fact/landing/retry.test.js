/** @pullboard-test-input apps/cli/index.js apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js apps/lib/index.js packages/landing/index.js packages/store/index.js */
/** Main-move retries preserve wake custody and never retry attributed failures [B35,C7,R3]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import * as store from '../../../../../packages/store/index.js';
import {
  landingHost,
  scheduleAutomaticLanding,
  automaticLandingDirectory,
} from '../../../../../packages/landing/index.js';
import { bootstrapLandingWake } from '../../../src/io/landing/automatic.js';
import { retryableLandingBatch } from '../../../../../packages/landing/src/logic/retry.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Make one fixture commit through ordinary hooks and return its full hash. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

test('a diagnostic block is superseded after main moves and lands without another accept [B35,C7,R3]', () => {
  const box = landProject();
  const entry = itemWorktree(box, 1, FILES[0], [], 'node --test web/land-1.test.js');
  submitItem(box, entry, "import test from 'node:test'; import assert from 'node:assert/strict'; test('land fixture passes', () => assert.ok(true));\n");
  acceptItem(box, entry);
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  commit(box, box.repo, 'chore: enable automatic landing');
  const oldMain = box.git(box.repo, 'rev-parse', 'main');
  const directory = join(box.repo, '.git', 'pullboard', 'landings', randomUUID());
  mkdirSync(directory, { recursive: true });
  const blockedId = directory.split('/').at(-1);
  const batchRoot = join(directory, 'worktree');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', batchRoot, oldMain);
  onBoard(box, board => store.recordLandingBatch(board, { agentId: 'coordinator', batch: {
    version: 1, id: blockedId, startedAt: new Date().toISOString(), base: oldMain, tip: entry.commit,
    branch: 'refs/heads/main', root: batchRoot, candidates: [{ id: entry.item, commit: entry.commit }],
    items: [{ id: entry.item, commit: entry.commit }], conflicts: [], blocked: [], state: 'blocked',
    refusal: { code: 'LAND_DIAGNOSTIC', message: 'fixture diagnostic refusal' }, culprits: [],
    owner: 'crashed-fixture-session', host: landingHost(), logPath: join(directory, 'batch.log'), revision: 0,
  } }));
  const job = bootstrapLandingWake(box.repo, { schedule: async (root, at, url, options) => scheduleAutomaticLanding(root, at, url, { ...options, schedule: async () => {} }) });
  const source = [
    `import { resumeAutomaticLanding, scheduleAutomaticLanding } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { runLandingWake, wakeIo } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../src/io/landing/automatic.js')).href)};`,
    `import { context, landAfterAcceptance } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../index.js')).href)};`,
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { runFixtureGit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../tests/fixtures/child.js')).href)};`,
    `import { join } from 'node:path'; import { readFileSync, existsSync } from 'node:fs';`,
    'const [root, token, dueAt, mode, itemId, blockedId] = process.argv.slice(1);',
    'const pendingFile = join(root, ".git/pullboard/automatic-landing/pending.json"); let waits=0, lands=0;',
    'const schedule = async (actualRoot, at, url, opts={}) => scheduleAutomaticLanding(actualRoot, at, url, { ...opts, schedule: async () => { const p=JSON.parse(readFileSync(pendingFile,"utf8")); if (p.running !== undefined) throw Error("running custody not released before replacement timer"); } });',
    'const run = mode === "first" ? (actualRoot => runLandingWake(actualRoot,{ land: async () => { lands++; throw Object.assign(Error("diagnostic"),{code:"LAND_DIAGNOSTIC"}); }, wait: async () => { waits++; if (waits === 2) runFixtureGit(["commit","--allow-empty","-q","-m","chore: correct main after diagnostic"],{cwd:root}); }, pollMs:1 })) : (async actualRoot => { lands++; await landAfterAcceptance(context(wakeIo(actualRoot))); });',
    'const ok = await resumeAutomaticLanding(root,token,dueAt,run,{wait:async()=>true,schedule});',
    'const pending=existsSync(pendingFile)?JSON.parse(readFileSync(pendingFile,"utf8")):null; const board=openBoard(join(root,".git/pullboard/board.sqlite")); try { console.log("RESULT "+JSON.stringify({ok,waits,lands,pending,blocked:store.landingBatches(board).find(b=>b.id===blockedId),batches:store.landingBatches(board),item:store.getItem(board,Number(itemId))})); } finally { store.closeBoard(board); }',
  ].join('\n');
  return job.then(async bootstrapped => {
    assert.equal(bootstrapped, true, 'bootstrap creates a wake for verified work without a new accept');
    const queued = JSON.parse(readFileSync(join(automaticLandingDirectory(box.repo), 'pending.json'), 'utf8'));
    const first = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, 'fixture-token', queued.dueAt, 'first', String(entry.item), blockedId], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.failure ?? first.stderr}\n${first.stdout}`);
    const observed = JSON.parse(first.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.ok(observed.ok);
    assert.equal(observed.lands, 1, 'unchanged-main wait does not retry the refusal');
    assert.equal(observed.waits, 2, 'the injected correction follows one same-main observation');
    assert.notEqual(observed.pending.id, queued.id, 'main correction creates a fresh scheduled wake');
    const pending = JSON.parse(readFileSync(join(automaticLandingDirectory(box.repo), 'pending.json'), 'utf8'));
    assert.equal(pending.running, undefined, 'freshly scheduled worker can acquire custody');
    const correctedMain = box.git(box.repo, 'rev-parse', 'main');
    const second = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, 'fixture-token', pending.dueAt, 'second', String(entry.item), blockedId], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
    assert.equal(second.status, 0, `${second.failure ?? second.stderr}\n${second.stdout}`);
    const landed = JSON.parse(second.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.equal(landed.blocked.supersededByMain, correctedMain);
    assert.ok(landed.item.item_merged_commit, 'the accepted item lands without another accept');
    assert.ok(landed.batches.some(batch => batch.id !== blockedId && batch.state === 'landed'));
    assert.equal(retryableLandingBatch({ state: 'blocked', base: oldMain, refusal: { code: 'LAND_DIAGNOSTIC' }, blocked: [], culprits: [] }, `${oldMain}changed`), true);
    assert.equal(retryableLandingBatch({ state: 'blocked', base: oldMain, refusal: { code: 'LAND_DIAGNOSTIC' }, blocked: [], culprits: [{ id: entry.item }] }, `${oldMain}changed`), false);
    assert.equal(onBoard(box, board => store.landingBatches(board).find(batch => batch.id === blockedId).refusal.code), 'LAND_DIAGNOSTIC');
  });
});

test('a stale main observer cannot replace a newer acceptance timer [B35,R3]', async t => {
  const root = join(e2e.sandbox().dir, 'scheduler-race');
  mkdirSync(root, { recursive: true });
  runFixtureGit(['init', '-q'], { cwd: root });
  const worker = new URL('../../../src/io/landing/automatic.js', import.meta.url);
  const timers = [];
  const first = await scheduleAutomaticLanding(root, new Date(Date.now() + 10_000).toISOString(), worker, { schedule: async (...args) => timers.push(args) });
  const second = await scheduleAutomaticLanding(root, new Date(Date.now() + 20_000).toISOString(), worker, { expectedId: first.id, schedule: async (...args) => timers.push(args) });
  const stale = await scheduleAutomaticLanding(root, new Date(Date.now() + 30_000).toISOString(), worker, { expectedId: first.id, schedule: async (...args) => timers.push(args) });
  const pending = JSON.parse(readFileSync(join(automaticLandingDirectory(root), 'pending.json'), 'utf8'));
  assert.equal(stale, null);
  assert.equal(pending.id, second.id);
  assert.equal(pending.dueAt, second.dueAt);
  assert.equal(timers.length, 2, 'the stale observer creates no timer');
});

test('a moved main does not restart a batch with an attributed culprit [B35,C7]', async () => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  const base = commit(box, box.repo, 'chore: enable culprit hold fixture');
  const id = randomUUID(), directory = join(box.repo, '.git', 'pullboard', 'landings', id);
  mkdirSync(directory, { recursive: true });
  onBoard(box, board => {
    const checked = store.checkedLandingCommit(board, store.getItem(board, entry.item));
    const carried = { id: entry.item, commit: entry.commit, reviewedCommit: checked };
    store.recordLandingBatch(board, { agentId: 'coordinator', batch: {
      version: 1, id, startedAt: new Date().toISOString(), base, tip: checked, branch: 'refs/heads/main',
      root: join(directory, 'worktree'), candidates: [carried], items: [carried], conflicts: [], blocked: [],
      state: 'blocked', refusal: { code: 'LAND_DIAGNOSTIC', message: 'prior attributed failure' },
      culprits: [{ ...carried, tests: [{ file: entry.file, name: 'attributed fixture failure' }] }],
      owner: 'crashed-fixture', logPath: join(directory, 'batch.log'), revision: 0,
    } });
  });
  await scheduleAutomaticLanding(box.repo, new Date(Date.now() + 60_000).toISOString(),
    new URL('../../../src/io/landing/automatic.js', import.meta.url), { schedule: async () => {} });
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'chore: advance main beyond culprit batch');
  const source = [
    `import { wakeIo } from ${JSON.stringify(new URL('../../../src/io/landing/automatic.js', import.meta.url).href)};`,
    `import { context, landAfterAcceptance } from ${JSON.stringify(new URL('../../../index.js', import.meta.url).href)};`,
    'await landAfterAcceptance(context(wakeIo(process.argv[1])));',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  onBoard(box, board => {
    const batches = store.landingBatches(board);
    assert.equal(batches.length, 1, 'no replacement batch starts for the culprit');
    assert.equal(batches[0].id, id);
    assert.equal(batches[0].state, 'blocked');
    assert.equal(batches[0].supersededByMain, undefined);
    assert.equal(store.getItem(board, entry.item).item_merged_commit, null);
  });
});

test('retry guards reject culprit, held and same-base batches [B35,C7]', () => {
  const base = 'a'.repeat(40);
  const candidate = { state: 'blocked', base, refusal: { code: 'LAND_DIAGNOSTIC' }, blocked: [], culprits: [] };
  for (const code of ['LAND_DIAGNOSTIC', 'RUNNER_SOURCE', 'RUNNER_UNAVAILABLE', 'SLOT_DB_LOCKED', 'LAND_GATE_TIMEOUT']) {
    assert.equal(retryableLandingBatch({ ...candidate, refusal: { code } }, 'b'.repeat(40)), true, code);
  }
  assert.equal(retryableLandingBatch(candidate, base), false);
  assert.equal(retryableLandingBatch({ ...candidate, culprits: [{ id: 1 }] }, 'b'.repeat(40)), false);
  assert.equal(retryableLandingBatch({ ...candidate, blocked: [{ code: 'ITEM_HELD' }] }, 'b'.repeat(40)), false);
  assert.equal(retryableLandingBatch({ ...candidate, refusal: { code: 'LAND_INTERACTION' } }, 'b'.repeat(40)), false);
});
