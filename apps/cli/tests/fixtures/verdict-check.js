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
import { withFixtureBoard } from './board.js';
import { getItem } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { fixtureProjectPolicy } from './testkit.js';
import { FIXTURE_MODEL } from './testkit.js';
import { fixtureSettledMachine } from './testkit.js';
import { settledGateJob } from './submit/settle.js';
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
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MODEL: 'claude-opus-fixture', // join refuses a session that has not declared its model (MODEL_REQUIRED).
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_CLAIM_BEATER: '0', // no detached claim beater writes into the fixture while it is removed (#5726).
  });
  delete env.NODE_TEST_CONTEXT; // A fixture CLI/compiler child is a normal process, not its parent's Node test worker.
  // The fixture acts as the person's own terminal: an inherited agent or SSH session would make its verdicts self-verification.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  mkdirSync(env.HOME);
  // The submit's gate is a pulled job the loopback local runner settles; `submitSettled` waits for it [P7].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
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
  fixtureProjectPolicy(repo, { spec: SPEC, config: {
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  } });
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  box.env.PULLBOARD_MODEL ||= FIXTURE_MODEL;
  assert.match((await fixtureJoin(box.run, web, 'web')).out, /joined as web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
export async function succeeds(box, cwd, ...args) {
  const result = await box.run(cwd, ...args);
  assert.equal(result.code, 0, result.failure ? `${result.failure}\nstdout:\n${safeFixtureDiagnostic(result.out, box.env)}` : `${result.out}\n${result.err}`);
  return result.out;
}

/**
 * Submit one claimed item and wait for its pulled gate job: a pull submit returns queued, and the loopback local runner's
 * receipt settles it before a verdict reads the item [P7,#6249].
 *
 * @param {object} box - The sandbox.
 * @param {string} repo - The fixture repository.
 * @param {string} web - The builder's worktree.
 * @param {number} id - The claimed item.
 * @returns {Promise<object>} The submit's parsed document with the settled `gate` under it.
 */
export async function submitSettled(box, repo, web, id) {
  const submitted = JSON.parse(await succeeds(box, web, 'submit', String(id), '--no-next', '--json'));
  if (!submitted.queued) return submitted;
  if (submitted.localRunner?.pid) (box.runnerPids ??= []).push(submitted.localRunner.pid);
  const gateJob = await settledGateJob({ repo, env: box.env, run: box.run }, id);
  return { ...submitted, gate: gateJob.gate, gateJob };
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
  await submitSettled(box, repo, web, id);
  box.git(repo, 'switch', '--detach', 'web/one');
  return { id, commit: box.git(web, 'rev-parse', 'HEAD') };
}

/** Remove all files created by a test's private repository and SQLite board. */
export function clean(box) {
  for (const pid of box.runnerPids ?? []) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(box.dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 }); // a just-finished in-process submit or a detached board writer may still be writing its last files; retry ENOTEMPTY rather than fail the case [C7]
}

/**
 * Write a legacy accept straight into the board file the CLI wrote, so no `check` field is recorded in its event.
 *
 * Why: only the board file can hold a verdict from before the frozen check travelled with accepts; keeping the store
 * calls here leaves the journey test free of a static store import.
 *
 * @param {string} boardFile - The project's board.sqlite path.
 * @param {{ id: number, commit: string }} submittedItem - The submitted item as `submitted` returns it.
 */
export function legacyAccept(boardFile, submittedItem) {
  // @pullboard-board-file journey: read verdicts from the board file the real CLI wrote
  withFixtureBoard(boardFile, (board) => {
    const item = getItem(board, submittedItem.id);
    verify(board, submittedItem.id, {
      agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'legacy event fixture',
      head: submittedItem.commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    });
  });
}
