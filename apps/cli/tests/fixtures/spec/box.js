/** Shared spec project fixtures for the split spec journey files. */
import { runCliInProcess } from '../process.js';
import { journeyCall } from '../e2e.js';
import { stopFixtureLocalRunners } from '../runner/local-stop.js';
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../child.js';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';

export const SPEC = `# Demo

Intro line.

## G · Goals
- G1 [approved, must] Same file twice is a no-op. | gate: idempotency test
- G1.2 [draft, aim] Shows a diff. | serves: G1
- G2 [retired] Old idea.

## K · Constraints
- K1 [approved, must] Runs offline. | gate: e2e test | serves: G1, G1.2
`;

/**
 * A real repo and board with an isolated registry, so JSON exercises the command's lint and history
 * checks rather than just serializing the parser. Its files may use the configured names.
 */
export function specBox(t, options = {}) {
  const made = prepareBox(t, options);
  const init = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'init'], { cwd: made.root, env: made.env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return finishBox(made, options);
}

/**
 * The same box with `init` run in this process: awaited, with no CLI start per box [C7].
 * Why: a case that builds several boxes paid one real process each; the in-process call writes the same files.
 */
export async function specBoxInProcess(t, options = {}) {
  const made = prepareBox(t, options);
  const init = await runCliInProcess(['init'], { cwd: made.root, env: made.env });
  assert.equal(init.status, 0, init.stderr);
  return finishBox(made, options);
}

/** Everything a box needs before `init` runs: the folder, the shim, the environment, the commands and the repository. */
function prepareBox(t, { separateGitDir = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-json-')));
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, '../../../pullboard.js')}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    // Beside the repo, not in it: the board write log lives in the machine home and must not dirty the committed tree.
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: `${root}-home`,
    PULLBOARD_MACHINE_HOME: `${root}-home`,
  };
  // Stop the box's local runner first, then remove home and root together; a late compile-cache write is retried, never ENOTEMPTY [C7]
  t.after(() => {
    stopFixtureLocalRunners([`${root}-home`]);
    rmSync(`${root}-home`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  delete env.PULLBOARD_RELAY_TOKEN;
  // These isolated signoff fixtures model the same person terminal as the suite runner.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  const command = (...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const run = (...args) => command('spec', ...args);
  /** The same commands in this process: awaited, same result fields, no ~1 s CLI startup [C7]. */
  // PULLBOARD_JOURNEY_MODE=process answers the same call as a real process, so the gate's parity check can compare the two (#8267).
  const cmd = (...args) => journeyCall({ dir: root, env, cwd: root, args, inProcess: () => runCliInProcess(args, { cwd: root, env }), real: () => command(...args) });
  const spec = (...args) => cmd('spec', ...args);
  // A --separate-git-dir repository keeps its Git metadata in another folder (#915).
  const metadata = separateGitDir ? realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-git-'))) : null;
  if (metadata) t.after(() => rmSync(metadata, { recursive: true, force: true }));
  git('init', '-q', '-b', 'main', ...(metadata ? ['--separate-git-dir', join(metadata, 'repo.git')] : []));
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  return { root, env, git, run, command, cmd, spec };
}

/** Configure and commit a box once `init` has run; the setup commits skip the hooks, which no case here proves (they cost a process each) [C7]. */
function finishBox({ root, env, git, run, command, cmd, spec }, { specName = 'SPEC.md', practiceName = 'PRACTICE.md', practice, specSource = SPEC, freshInit = false } = {}) {
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  if (freshInit) {
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: fresh pullboard init');
    return { root, run, command, cmd, spec, env, git, specName: config.spec, practiceName: config.practice };
  }
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, spec: specName, practice: practiceName, gate: 'true', lanes: { review: { owns: [] } } }));
  rmSync(join(root, 'SPEC.md'), { force: true });
  rmSync(join(root, 'PRACTICE.md'), { force: true });
  rmSync(join(root, 'DOCTRINE.md'), { force: true });
  writeFileSync(join(root, specName), specSource);
  if (practice !== undefined) writeFileSync(join(root, practiceName), practice);
  git('add', '-A');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: a spec');
  return { root, run, command, cmd, spec, env, git, specName, practiceName };
}

/** Blueprint questions as blueprint add writes them: the default answer, then every choice; B5 lists 13 parts. */
export const QUESTION_SPEC = `${SPEC}
## B · Blueprint
- B1 [pending, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review
- B2 [pending, must] Which store holds the cache: SQLite. Choices: SQLite, Postgres. | gate: review
- B3 [pending, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review
- B4 [pending, must] Which store holds the files: SQLite. Choices: SQLite, Postgres. | gate: review
- B5 [pending, must] Which region hosts it: r1. Choices: r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13. | gate: review
`;

/** Run one CLI command in this process in a box with an environment of the test's choosing [C7]. */
export function runInProcessAt(box, cwd, args, env = box.env) {
  return runCliInProcess(args, { cwd, env });
}

/** Run one CLI command in a box with an environment of the test's choosing. */
export function runIn(box, cwd, args, env = box.env) {
  return runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args], { cwd, env, encoding: 'utf8' });
}

/** Send one move through the view's own API adapter, executeMove, on the channel named. */
export function viewMove(box, move, channel, env) {
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../native.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../../lib/src/logic/native.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { openBoard, openBoardForRead, moveArgs };
    const response = await executeMove(process.cwd(), ${JSON.stringify(move)}, main, undefined, ${JSON.stringify(channel)}, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify(response));
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

/** The board's person row decisions, read without opening its migrator. */
export function boardRowDecisions(box) {
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='row_decisions'").get()?.meta_value ?? '[]'; }
  finally { db.close(); }
}

export const SETUP_SPEC = `# Spec

## A · Setup
- A1 [draft, must] Every page works at phone width. | gate: review
- A2 [pending, must] It deploys to: Vercel. Choices: Vercel, Netlify. | gate: review
`;

/** Refuse a spec answer in an agent shell, then paste the returned command as the person would. */
export function answerCommandCase(t, separateGitDir) {
  const box = specBox(t, { specSource: QUESTION_SPEC, separateGitDir });
  const before = readFileSync(join(box.root, box.specName), 'utf8');
  const refused = runIn(box, box.root, ['spec', 'answer', 'B2', "Redis on the host's port", '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.notEqual(refused.status, 0, 'an agent shell never records a person answer');
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'B26_PERSON_CHANNEL');
  assert.match(error.message, /relay the command below to the person verbatim/u);
  const pasted = error.next.slice(error.next.lastIndexOf(': cd ') + 2);
  assert.equal(pasted, `cd ${box.root} && pullboard spec answer B2 'Redis on the host'\\''s port'`, 'the id and the proposed choice, quoted, with no placeholder');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), before);
  // The person pastes it into their own terminal and it is recorded.
  const person = runFixtureChild('/bin/sh', ['-c', pasted.replace(/^cd \S+ && pullboard/u, `cd '${box.root}' && "${process.execPath}" "${resolve(import.meta.dirname, '../../../pullboard.js')}"`) + ' --json'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(person.status, 0, person.stdout + person.stderr);
  assert.equal(JSON.parse(person.stdout).decisions[0].answer, "Redis on the host's port");
}
