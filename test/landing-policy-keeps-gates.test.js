/** Policy sealing distinguishes landing scheduling from the proof a queued gate owes [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { getItem, sealClauseInspection, submitHandoff } from '../packages/store/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { submitUntilSettled } from '../apps/lib/src/shell/submit-infra-requeue.js';
import { runFixtureGit } from './fixture-child.js';

/** Commit actual accepted policy changes in a private Git repo and use its real file board. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-landing-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Run Git only in the owned fixture repo. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  git('init', '-q', '-b', 'main');
  /** Advance accepted main using the exact serialized policy, without mutating a receipt. */
  const commit = config => {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config));
    git('add', 'pullboard.json');
    git('commit', '-qm', 'chore: fixture policy');
    return git('rev-parse', 'HEAD');
  };
  const initial = commit({});
  mkdirSync(join(root, '.git/pullboard'), { recursive: true });
  const board = openBoard(join(root, '.git/pullboard/board.sqlite'));
  t.after(() => closeBoard(board));
  const options = { agentId: 'fixture', policyCommit: initial, commit: initial, tree: git('rev-parse', 'HEAD^{tree}') };
  return { board, commit, initial, options };
}

for (const phase of ['queued', 'running']) test(`a ${phase} submit retains its sealed proof after landing-only policy changes [C7,V4]`, t => {
  const f = fixture(t);
  const original = sealClauseInspection(f.board, 1, f.options);
  f.commit({ landing: { manualOverride: true, cadence: '1s' } });
  assert.deepEqual(sealClauseInspection(f.board, 1, f.options), original,
    'landing scheduling leaves captured policy provenance and inspection authority unchanged');
  f.commit({ landing: { manualOverride: false, cadence: '2s' } });
  assert.deepEqual(sealClauseInspection(f.board, 1, f.options), original);
});

for (const policy of [{ gate: 'false' }, { check: { timeout: '2s' } }]) test(`changed ${Object.keys(policy)[0]} policy requeues a captured submit and never becomes a test red [C7,V4]`, async t => {
  const f = fixture(t);
  sealClauseInspection(f.board, 1, f.options);
  f.commit(policy);
  let attempts = 0;
  const notices = [];
  await assert.rejects(submitUntilSettled(async () => {
    attempts++;
    return sealClauseInspection(f.board, 1, f.options);
  }, { retries: 1, healthy: async () => true, wait: async () => {}, say: line => notices.push(line) }),
  { code: 'GATE_INFRA_EXHAUSTED' });
  assert.equal(attempts, 2, 'the native worker retry loop requeues the same captured source');
  assert.ok(notices.some(line => line.includes('NO_POLICY') && line.includes('not a red')));
  assert.throws(() => sealClauseInspection(f.board, 1, f.options), { code: 'NO_POLICY' },
    'old evidence never becomes valid under a changed gate/check policy');
});

/** Observe the real queue without opening a write transaction or supplying any proof receipt. */
function queuedState(box, id) {
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { return { job: submitHandoff(board, id), item: getItem(board, id) }; }
  finally { closeBoard(board); }
}

for (const landingOnly of [true, false]) test(`clause ${landingOnly ? 1 : 2}: a real running queued worker ${landingOnly ? 'finishes after landing changes' : 'requeues changed gate policy without a red'} [C7,V4]`, { timeout: 240_000 }, async t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const armed = join(box.dir, 'policy-armed');
  const entered = join(box.dir, 'policy-entered');
  const release = join(box.dir, 'policy-release');
  const script = join(box.dir, 'policy-check.cjs');
  writeFileSync(script, `const fs=require('node:fs');
if(fs.existsSync(${JSON.stringify(armed)}) && fs.existsSync('web/snapshot.txt')) {
 fs.writeFileSync(${JSON.stringify(entered)},'entered');
 const deadline=Date.now()+120000;
 while(!fs.existsSync(${JSON.stringify(release)})) {if(Date.now()>deadline)throw Error('owned fixture release missing');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
 if(fs.readFileSync('web/snapshot.txt','utf8')!=='candidate\\n')throw Error('wrong captured source');
}
console.log('TAP version 13\\n# Subtest: captured policy fixture\\nok 1 - captured policy fixture\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');\n`);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.submit = { ...config.submit, handoff: true };
  writeFileSync(configFile, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: captured worker policy');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Captured policy change', '--specs', 'G1',
    '--criterion', 'The captured source check passes.', '--brief', 'Files:\n- web/snapshot.txt\nTest:\n- captured source check\n',
    '--check', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  t.after(async () => {
    writeFileSync(release, 'release');
    const job = queuedState(box, id).job;
    if (job) await helpers.waitFor(() => !existsSync(join(box.repo, '.git/pullboard/submit-handoffs', job.id, 'source')), // budget: owned worker cleanup hang ceiling
      'owned worker cleanup', 180_000); // budget: owned-child cleanup hang ceiling, no performance claim
    helpers.cleanup();
  });
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const source = JSON.parse(claimed.out).itemFolder ?? box.web;
  const committed = helpers.commitFile(box, source, 'web/snapshot.txt', 'candidate\n', 'feat(web): captured policy fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  writeFileSync(armed, 'armed');
  const submitted = box.run(source, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  assert.equal(JSON.parse(submitted.out).queued, true);
  await helpers.waitFor(() => existsSync(entered), 'actual queued worker entered frozen check', 120_000); // budget: owned worker readiness hang ceiling
  assert.equal(queuedState(box, id).job.state, 'running');
  if (landingOnly) config.landing = { ...config.landing, manualOverride: true };
  else config.gate = 'node -e "process.exit(0)"';
  writeFileSync(configFile, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: advance accepted policy');
  writeFileSync(release, 'release');
  await helpers.waitFor(() => ['green', 'infrastructure', 'red', 'incomplete'].includes(queuedState(box, id).job?.state), // budget: bounded native worker retries hang ceiling
    'actual queued worker terminal result', 180_000); // budget: bounded worker retries and cleanup hang ceiling
  const terminal = queuedState(box, id);
  assert.equal(terminal.job.state, landingOnly ? 'green' : 'infrastructure', JSON.stringify(terminal));
  assert.equal(terminal.item.item_status, landingOnly ? 'submitted' : 'claimed');
  if (!landingOnly) assert.equal(terminal.job.error.code, 'GATE_INFRA_EXHAUSTED');
});
