/** Shared sandbox for the verdict check journeys: a private CLI environment, a fixture project and one submitted item [V19,V8]. */
import assert from 'node:assert/strict';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import { safeFixtureDiagnostic } from './child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fixtureJoin } from './testkit.js';
import { fixtureMachineSettings } from './testkit.js';
import { runCliInProcess } from './process.js';

const BIN = resolve(import.meta.dirname, "../../pullboard.js");
const SPEC = '# Fixture\n\n## G · Goals\n- G1 [approved, must] The fixture item is complete. | gate: none\n';

/** Create a private CLI environment with isolated Git, home and board state. */
export function sandbox() {
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
    PULLBOARD_MODEL: 'claude-opus-fixture', // join refuses a session that has not declared its model (MODEL_REQUIRED).
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_CLAIM_BEATER: '0', // no detached claim beater writes into the fixture while it is removed (#5726).
  });
  delete env.NODE_TEST_CONTEXT; // A fixture CLI/compiler child is a normal process, not its parent's Node test worker.
  // The fixture acts as the person's own terminal: an inherited agent or SSH session would make its verdicts self-verification.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  mkdirSync(env.HOME);
  // This journey holds its gate in the submitting process, so it pins controller dispatch and the default may move to pull [P7].
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  /** Run isolated Git commands for this fixture. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run the checked-out CLI without invoking any shared board. */
  const run = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  /** A real CLI process, for the cases named process-level where in-process dispatch skips the child they start. */
  const spawn = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  return { dir, env, git, run, spawn };
}

/** Initialize a real board repository and one joined builder worktree. */
export async function project(box) {
  const repo = join(box.dir, 'repo');
  const web = join(box.dir, 'web-1');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  // The spec is in place before init, so the board's approval baseline holds its approved rows as the person's (#960).
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  assert.equal((await box.run(repo, 'init')).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  box.env.PULLBOARD_MODEL ||= 'Fixture builder';
  assert.match((await fixtureJoin(box.run, web, 'web')).out, /joined as web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
export async function succeeds(box, cwd, ...args) {
  const result = await box.run(cwd, ...args);
  assert.equal(result.code, 0, result.failure ? `${result.failure}\nstdout:\n${safeFixtureDiagnostic(result.out, box.env)}` : `${result.out}\n${result.err}`);
  return result.out;
}

/** Add, claim, commit and submit one real worktree item with its optional frozen check. */
export async function submitted(box, repo, web, title, check) {
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is complete.', '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check'];
  if (check) args.push('--check', check, '--wait'); // --wait: the detached baseline worker exits before the fixture is removed
  const added = await succeeds(box, repo, ...args);
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  assert.ok(id > 0, added);
  await succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  await succeeds(box, web, 'submit', String(id), '--wait');
  box.git(repo, 'switch', '--detach', 'web/one');
  return { id, commit: box.git(web, 'rev-parse', 'HEAD') };
}

/** Remove all files created by a test's private repository and SQLite board. */
export function clean(box) {
  rmSync(box.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // a just-finished in-process submit may still be writing its last files
}
