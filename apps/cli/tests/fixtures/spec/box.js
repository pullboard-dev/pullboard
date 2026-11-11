/** Shared spec project fixtures for the split spec journey files. */
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
export function specBox(t, { specName = 'SPEC.md', practiceName = 'PRACTICE.md', practice, specSource = SPEC, freshInit = false, separateGitDir = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-json-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
    PULLBOARD_HOME: `${root}-home`,
    PULLBOARD_MACHINE_HOME: `${root}-home`,
  };
  t.after(() => rmSync(`${root}-home`, { recursive: true, force: true }));
  delete env.PULLBOARD_RELAY_TOKEN;
  // These isolated signoff fixtures model the same person terminal as the suite runner.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  const command = (...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const run = (...args) => command('spec', ...args);
  // A --separate-git-dir repository keeps its Git metadata in another folder (#915).
  const metadata = separateGitDir ? realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-git-'))) : null;
  if (metadata) t.after(() => rmSync(metadata, { recursive: true, force: true }));
  git('init', '-q', '-b', 'main', ...(metadata ? ['--separate-git-dir', join(metadata, 'repo.git')] : []));
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  const init = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'init'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  if (freshInit) {
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: fresh pullboard init');
    return { root, run, command, env, git, specName: config.spec, practiceName: config.practice };
  }
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, spec: specName, practice: practiceName, gate: 'true', lanes: { review: { owns: [] } } }));
  rmSync(join(root, 'SPEC.md'), { force: true });
  rmSync(join(root, 'PRACTICE.md'), { force: true });
  rmSync(join(root, 'DOCTRINE.md'), { force: true });
  writeFileSync(join(root, specName), specSource);
  if (practice !== undefined) writeFileSync(join(root, practiceName), practice);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  return { root, run, command, env, git, specName, practiceName };
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
