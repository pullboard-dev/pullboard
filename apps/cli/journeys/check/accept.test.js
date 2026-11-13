/** Accept reverts a named guard in a scratch tree and needs the frozen check red there, green restored [C7,V4]. */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const SPEC = '# Fixture\n\n## G · Goals\n- G1 [approved, must] The fixture item is complete. | gate: none\n';
const SOURCE = 'export const answer = 42;\n// kept\n';

/** Create a private CLI environment with isolated Git, home and board state. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-guard-'));
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
  delete env.NODE_TEST_CONTEXT;
  mkdirSync(env.HOME);
  /** Run isolated Git commands for this fixture. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run the checked-out CLI in this process without invoking any shared board. */
  const runLocal = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { dir, env, git, runLocal };
}

/** Initialize a real board repository and one joined builder worktree. */
async function project(box) {
  const repo = join(box.dir, 'repo');
  const web = join(box.dir, 'web-1');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  box.env.PULLBOARD_MODEL ||= 'Fixture builder';
  const joined = await joinFixtureSeat(box, web, 'web', { run: box.runLocal });
  assert.equal(joined.code, 0, joined.out + joined.err);
  assert.match(joined.out, /web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
async function succeeds(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, safeFixtureDiagnostic(`${result.out}\n${result.err}`, box.env));
  return result.out;
}

/** Add, claim, commit and submit an item whose criterion names a guard, then check out its commit. */
async function submittedWithGuard(box, repo, web, check) {
  const criterion = 'The fixture item is complete. guard: web/guard.js:1-1';
  const added = await succeeds(box, repo, 'add', 'web', 'Guarded fix', '--specs', 'G1', '--criterion', criterion, '--check', check, '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check');
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  await succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', 'guard.js'), SOURCE);
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `fix(web): guarded fix [G1]`);
  await succeeds(box, web, 'submit', String(id));
  box.git(repo, 'switch', '--detach', 'web/one');
  return id;
}

test('accept refuses a fix whose guard revert stays green [C7,V4]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const id = await submittedWithGuard(box, repo, web, 'test -f web/guard.js');
    const refused = await box.runLocal(repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'the check passed');
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(`${refused.out}\n${refused.err}`, /GUARD_CANNOT_FAIL/u);
    assert.match(`${refused.out}\n${refused.err}`, /web\/guard\.js:1-1/u, 'the refusal names the guard');
  } finally { rmSync(box.dir, { recursive: true, force: true }); }
});

test('a named guard that turns the check red is accepted [C7,V4]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const id = await submittedWithGuard(box, repo, web, 'grep -q "answer = 42" web/guard.js');
    const accepted = await succeeds(box, repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'the check passed');
    assert.match(accepted, /verified #/u);
    const shown = await succeeds(box, repo, 'show', String(id));
    assert.match(shown, /guard web\/guard\.js:1-1 reverted: check red; restored: check green/u);
  } finally { rmSync(box.dir, { recursive: true, force: true }); }
});
