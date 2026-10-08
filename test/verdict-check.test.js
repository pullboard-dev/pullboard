/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const SPEC = '# Fixture\n\n## G · Goals\n- G1 [approved, must] The fixture item is complete. | gate: none\n';

/** Create a private CLI environment with isolated Git, home and board state. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-verdict-check-'));
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shimDir, 'pullboard'), 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    PATH: `${shimDir}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture agent',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture agent',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  });
  mkdirSync(env.HOME);
  /** Run isolated Git commands for this fixture. */
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run the checked-out CLI without invoking any shared board. */
  const run = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { dir, env, git, run };
}

/** Initialize a real board repository and one joined builder worktree. */
function project(box) {
  const repo = join(box.dir, 'repo');
  const web = join(box.dir, 'web-1');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.match(box.run(web, 'join', 'web').out, /joined as web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
function succeeds(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result.out;
}

/** Add, claim, commit and submit one real worktree item with its optional frozen check. */
function submitted(box, repo, web, title, check) {
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is complete.'];
  if (check) args.push('--check', check);
  const added = succeeds(box, repo, ...args);
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  assert.ok(id > 0, added);
  succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  succeeds(box, web, 'submit', String(id));
  box.git(repo, 'switch', '--detach', 'web/one');
  return { id, commit: box.git(web, 'rev-parse', 'HEAD') };
}

/** Remove all files created by a test's private repository and SQLite board. */
function clean(box) {
  rmSync(box.dir, { recursive: true, force: true });
}

test('accept records none or green in its event and JSON, and says when unchecked [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const unchecked = submitted(box, repo, web, 'Unchecked accept');
    const noCheck = succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    assert.match(noCheck, /no frozen check ran/);
    const uncheckedEvent = JSON.parse(succeeds(box, repo, 'log', String(unchecked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(uncheckedEvent.event_detail).check, 'none');
    const uncheckedShow = JSON.parse(succeeds(box, repo, 'show', String(unchecked.id), '--json'));
    assert.equal(uncheckedShow.verdicts.at(-1).check, 'none');
    assert.match(succeeds(box, repo, 'show', String(unchecked.id)), /check: none/);
    box.git(repo, 'switch', 'main');

    const uncheckedJson = JSON.parse(succeeds(box, repo, 'verify', String((submitted(box, repo, web, 'Unchecked JSON accept')).id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work', '--json'));
    assert.equal(uncheckedJson.check, 'none');
    box.git(repo, 'switch', 'main');

    const checked = submitted(box, repo, web, 'Checked accept', 'node --check web/item-3.js');
    const checkedJson = JSON.parse(succeeds(box, repo, 'verify', String(checked.id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json'));
    assert.equal(checkedJson.check, 'green');
    const checkedEvent = JSON.parse(succeeds(box, repo, 'log', String(checked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(checkedEvent.event_detail).check, 'green');
    const checkedShow = JSON.parse(succeeds(box, repo, 'show', String(checked.id), '--json'));
    assert.equal(checkedShow.verdicts.at(-1).check, 'green');
    assert.match(succeeds(box, repo, 'show', String(checked.id)), /check: green/);
  } finally { clean(box); }
});

test('rework keeps historical rejection unknown and shows the latest accept check [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const item = submitted(box, repo, web, 'Reworked accept');
    succeeds(box, repo, 'verify', String(item.id), 'reject', '--as', 'coordinator', '--reason', 'BEHAVIOR_MISMATCH', '--note', 'the first version missed an edge');
    box.git(repo, 'switch', 'main');
    succeeds(box, web, 'claim', String(item.id));
    writeFileSync(join(web, 'web', `item-${item.id}.js`), 'export const complete = true; // revised\n');
    box.git(web, 'add', '-A');
    box.git(web, 'commit', '-q', '-m', `fix(web): correct fixture ${item.id} [G1]`);
    succeeds(box, web, 'submit', String(item.id));
    box.git(repo, 'switch', '--detach', 'web/one');
    const accepted = succeeds(box, repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'the rework fixed the missed edge');
    assert.match(accepted, /no frozen check ran/);
    const shownJson = JSON.parse(succeeds(box, repo, 'show', String(item.id), '--json'));
    assert.deepEqual(shownJson.verdicts.map((verdict) => verdict.check), ['unknown', 'none']);
    const shown = succeeds(box, repo, 'show', String(item.id));
    assert.match(shown, /REJECT[\s\S]*check: unknown[\s\S]*ACCEPT[\s\S]*check: none/);
    const rows = succeeds(box, repo, 'ledger').split('\n').filter((line) => line.startsWith(`| ${item.id} |`));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\| unchecked \|/);
    assert.doesNotMatch(rows[0], /unknown/);
  } finally { clean(box); }
});

test('historical accepts read unknown in show and unchecked accepts are marked in ledger [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const historical = submitted(box, repo, web, 'Historical accept');
    const common = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const board = store.openBoard(join(common, 'pullboard', 'board.sqlite'));
    try {
      const item = store.getItem(board, historical.id);
      store.verify(board, historical.id, {
        agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'legacy event fixture',
        head: historical.commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
      });
    } finally { store.closeBoard(board); }
    const shown = succeeds(box, repo, 'show', String(historical.id));
    assert.match(shown, /check: unknown/);
    box.git(repo, 'switch', 'main');
    const unchecked = submitted(box, repo, web, 'Unchecked ledger row');
    succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'fixture accept without a frozen check');
    assert.match(succeeds(box, repo, 'ledger'), new RegExp(`\\| ${unchecked.id} \\|[^\\n]*\\| unchecked \\|`));
  } finally { clean(box); }
});
