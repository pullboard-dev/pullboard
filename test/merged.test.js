/** Merged receipts only record item work on the primary trunk, unless noted [R3,R1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard } from '../src/exchange.js';

const TEMP_DIRS = [];
const HOUR = 3_600_000;
const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Remove fixture repositories and their real SQLite boards after tests finish. */
function cleanup() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanup);

/** Run a command and keep its actual output for useful assertion failures. */
async function command(box, args, cwd = box.repo) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env: box.env, encoding: 'utf8', timeout: 30_000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Create an initialized real repo with one verified item commit and its claim base. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-merged-'));
  TEMP_DIRS.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  /** Quote executable paths used by the private hook shim. */
  const shellWord = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Merged fixture', GIT_AUTHOR_EMAIL: 'merged@example.invalid',
    GIT_COMMITTER_NAME: 'Merged fixture', GIT_COMMITTER_EMAIL: 'merged@example.invalid', PATH: `${bin}:${process.env.PATH}` });
  /** Run Git in this isolated fixture with its private identity. */
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  const initialized = await command({ repo, env }, ['init']);
  assert.equal(initialized.code, 0, `${initialized.stdout}${initialized.stderr}`);
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  git('add', '-A'); git('commit', '-q', '-m', 'chore: initialize fixture');
  const base = git('rev-parse', 'HEAD');
  const builder = join(dir, 'builder');
  git('worktree', 'add', '-q', builder, '-b', 'web/builder');
  const joined = await command({ repo, env }, ['join', 'web'], builder);
  assert.equal(joined.code, 0, `${joined.stdout}${joined.stderr}`);
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const agentId = store.listAgents(board).find((agent) => agent.agent_lane === 'web').agent_id;
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Tracked work', criterion: 'The item change is retained.', specIds: ['G1'] });
  const frozen = JSON.stringify({ criterion: 'The item change is retained.' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  store.claim(board, id, { agentId, lane: 'web', leaseMs: HOUR, freeze: () => ({ text: frozen, digest }), head: base });
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web', 'work.txt'), 'item change\n');
  execFileSync('git', ['add', 'web/work.txt'], { cwd: builder, env });
  execFileSync('git', ['commit', '-q', '-m', 'feat(web): retain item work [G1]'], { cwd: builder, env });
  const itemCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: builder, env, encoding: 'utf8' }).trim();
  store.submit(board, id, { agentId, commit: itemCommit, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: builder, env, encoding: 'utf8' }).trim() });
  store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'confirmed the committed file', head: itemCommit, digest, policy: 'any' });
  return { dir, repo, builder, env, git, board, id, base, itemCommit };
}

/** Read the latest merge event and decode its immutable detail. */
function mergeEvent(box) {
  const event = store.events(box.board, { itemId: box.id }).filter((entry) => entry.event_kind === 'merged').at(-1);
  return event ? JSON.parse(event.event_detail) : null;
}

/** Invoke merged and assert that its refusal names both the primary trunk and item commit. */
async function refusesUncarried(box, candidate) {
  const result = await command(box, ['merged', String(box.id), candidate, '--json']);
  assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /NOT_MERGED/u);
  assert.match(output, /refs\/heads\/main/u);
  assert.ok(output.includes(box.itemCommit), 'the refusal identifies the item commit');
  assert.equal(mergeEvent(box), null, 'a refusal does not record a merge');
}

test('[R3,R1] merged refuses the root and deleted side-branch commits', async (t) => {
  const rootCase = await fixture(t);
  await refusesUncarried(rootCase, rootCase.base);

  const sideCase = await fixture(t);
  sideCase.git('switch', '-c', 'unrelated');
  writeFileSync(join(sideCase.repo, 'unrelated.txt'), 'unrelated\n');
  sideCase.git('add', 'unrelated.txt');
  sideCase.git('commit', '-q', '-m', 'chore: unrelated work');
  sideCase.git('merge', '--no-ff', '-m', 'chore(test): merge item on side [G1]', 'web/builder');
  const deleted = sideCase.git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => sideCase.git('merge-base', '--is-ancestor', sideCase.itemCommit, deleted), 'the off-trunk candidate contains the item commit');
  sideCase.git('switch', 'main');
  sideCase.git('branch', '-D', 'unrelated');
  await refusesUncarried(sideCase, deleted);
});

test('[R3,R1] merged records fast-forward, merge, rebased and squashed work', async t => {
  for (const mode of ['fast-forward', 'merge', 'rebased', 'squashed']) {
    await t.test(`[R3,R1] records ${mode} work`, async () => {
      const box = await fixture(t);
      if (['merge', 'rebased'].includes(mode)) {
        writeFileSync(join(box.repo, 'trunk.txt'), 'trunk change\n');
        box.git('add', 'trunk.txt');
        box.git('commit', '-q', '-m', 'chore: advance trunk [G1]');
      }
      if (mode === 'fast-forward') box.git('merge', '--ff-only', 'web/builder');
      if (mode === 'merge') box.git('merge', '--no-ff', '--no-edit', 'web/builder');
      if (mode === 'rebased') box.git('cherry-pick', box.itemCommit);
      if (mode === 'squashed') {
        box.git('merge', '--squash', 'web/builder');
        box.git('commit', '-q', '-m', 'feat(web): squash item work [G1]');
      }
      const commit = box.git('rev-parse', 'HEAD');
      if (mode === 'rebased') assert.notEqual(commit, box.itemCommit, 'the item change was replayed on advanced trunk');
      const result = await command(box, ['merged', String(box.id), commit]);
      assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
      assert.equal(mergeEvent(box).commit, commit);
    });
  }
});

test('[R3,R1] --note records an otherwise uncarried merge receipt', async (t) => {
  const box = await fixture(t);
  const result = await command(box, ['merged', String(box.id), box.base, '--note', 'recorded outside trunk']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.equal(mergeEvent(box).commit, box.base);
  assert.equal(mergeEvent(box).note, 'recorded outside trunk');
});


test('[R3,H16] a released client stops before losing an exceptional merged note', async t => {
  const box = await fixture(t);
  const directory = join(box.dir, 'released');
  mkdirSync(directory);
  const archive = execFileSync('git', ['archive', 'v0.8.3'], { cwd: resolve(import.meta.dirname, '..'), maxBuffer: 32 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  const released = await import(pathToFileURL(join(directory, 'src/engine.js')).href);
  const machine = await import(pathToFileURL(join(directory, 'src/machine.js')).href);
  assert.equal(machine.ENGINE_VERSION, 6, 'exercise the actual released client');
  const move = prepareEngineMove(box.board, 'merged', [box.id, {
    agentId: 'coordinator', commit: box.base, note: 'recorded outside trunk',
  }]);
  const before = exportBoard(box.board);
  const receipt = { sequence: 1, at: '2026-10-10T00:00:00.000Z' };
  assert.throws(() => released.applyEngineMove(box.board, move, receipt), error => {
    assert.equal(error.code, 'ENGINE_VERSION');
    assert.match(error.message, new RegExp(`version ${move.engine}.*version 6.*upgrade`, 'iu'));
    return true;
  });
  assert.deepEqual(exportBoard(box.board), before, 'an old client does not drop the note or advance the replay cursor');
  const outcome = applyEngineMove(box.board, move, receipt);
  assert.equal(Boolean(outcome.error), false);
  assert.equal(mergeEvent(box).note, 'recorded outside trunk', 'the current engine retains the sealed explanation');
});
