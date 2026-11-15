/** Shared fixtures for the split blueprint test files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import { createE2eHelpers } from './e2e.js';
import { runCliInProcess } from './process.js';
import { runCliSync } from './sync/cli.js';
import { writeLegacyWebQuestions } from './blueprint/question.js';

/** @pullboard-test-input apps/cli/pullboard.js packages/blueprints/data/blueprints/web-app.json */
/** pullboard blueprint add: a blueprint lands on a board as drafts, once [S1,I1]. */

export const BIN = resolve(import.meta.dirname, '../../pullboard.js');
export const PUBLISHED = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../packages/blueprints/data/blueprints/web-app.json'), 'utf8'));
export const LEGACY_FRAMEWORK = { key: 'Q1', ask: 'The app is built with', choices: ['Next.js', 'SvelteKit', 'Rails', 'Something else'], detect: 'framework' };
export const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
export const DIRS = [];

/**
 * How a blueprint journey's synchronous calls reach the CLI: 'process' spawns node pullboard.js, 'inprocess' answers the
 * same argv with the production dispatch in a warm worker thread (no node start-up). One file uses one mode; the
 * pilot's baseline (item 8058) sets PULLBOARD_JOURNEY_MODE=process to run the same cases as real processes.
 */
export const JOURNEY_MODES = Object.freeze(['process', 'inprocess']);
let defaultMode = JOURNEY_MODES.includes(process.env.PULLBOARD_JOURNEY_MODE) ? process.env.PULLBOARD_JOURNEY_MODE : 'process';

/** Make every board this test file builds from here on answer in the given mode, unless the environment pins one. */
export function useJourneyMode(mode) {
  if (!JOURNEY_MODES.includes(mode)) throw new Error(`unknown journey mode ${mode}`);
  if (!JOURNEY_MODES.includes(process.env.PULLBOARD_JOURNEY_MODE)) defaultMode = mode;
}

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity. */
export function freshBoard(config = {}, { mode = defaultMode } = {}) {
  const { dir, repo, run, runIn, runLocal, runInLocal, env } = emptyRepo({ mode });
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const init = run('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const file = join(repo, 'pullboard.json');
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...config }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up blueprint fixture');
  return { dir, repo, run, runIn, runLocal, runInLocal, git, env };
}

/** Run one command with --json and return its document, failing with its output. */
export function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** An architecture blueprint whose rules name the reference each paraphrases; a fixture, never fetched. */
export const SOURCED = {
  blueprint: 1, name: 'edge-api', title: 'Edge API', version: 1, kind: 'architecture', by: 'Fixture', prefix: 'EA',
  rules: [
    { key: 'EA1', text: 'Every function has an error alarm.', why: 'a quiet failure is found by users first.',
      source: { name: 'Example Framework', id: 'OPS 8', url: 'https://example.com/framework/ops-8' } },
    { key: 'EA2', text: 'No function runs past its time limit.', why: 'the platform stops it there.', source: { name: 'Example Lens' } },
  ],
  questions: [{ key: 'Q1', ask: 'It runs on', choices: ['AWS', 'Cloudflare'], default: 'AWS' }],
  items: [
    { key: '1', title: 'Every function has an alarm', cites: ['EA1'], criterion: 'A test fails on a function without an alarm.', check: 'true' },
    { key: '2', title: 'No function exceeds its deadline', cites: ['EA2'], criterion: 'A test fails when a function exceeds its deadline.', check: 'true' },
  ],
};

/** Per-command telemetry the CLI writes under .git/pullboard: its trace, seat timing and the log of refused commands; not a board. */
export const TELEMETRY = /(?:^|[\\/])(?:trace[\\/][^\\/]+\.jsonl|seat-timing\.jsonl|blocks\.jsonl)$/u;

/**
 * Whether a command left a board in the repository: anything under .git/pullboard besides its telemetry. Why: the CLI
 * now records a trace of every command there, so the folder's existence no longer means a board was created [S1,I1].
 */
export function boardCreated(repo) {
  const folder = join(repo, '.git', 'pullboard');
  let entries;
  try { entries = readdirSync(folder, { recursive: true, withFileTypes: true }); } catch { return false; }
  return entries.some(entry => entry.isFile() && !TELEMETRY.test(join(entry.parentPath, entry.name).slice(folder.length + 1)));
}

/** A Git repository with history but no Pullboard yet, using the same private homes as freshBoard. */
export function emptyRepo({ mode = defaultMode } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-init-'));
  DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || MARKERS.includes(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Blueprint fixture', GIT_AUTHOR_EMAIL: 'blueprint@example.invalid',
    GIT_COMMITTER_NAME: 'Blueprint fixture', GIT_COMMITTER_EMAIL: 'blueprint@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const runIn = mode === 'inprocess'
    ? (cwd, ...args) => ({ ...runCliSync(args, { cwd, env }), failure: null })
    : (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const run = (...args) => runIn(repo, ...args);
  /** The same command through the production dispatch in this process; same result shape as runIn, awaited [C7]. */
  const runInLocal = (cwd, ...args) => runCliInProcess(args, { cwd, env });
  const runLocal = (...args) => runInLocal(repo, ...args);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  return { dir, repo, run, runIn, runLocal, runInLocal, env };
}

export const RUNNERS = 'Choices: node:test, Vitest, Jest, Mocha, pytest, Something else.';
export const FRAMEWORKS = 'Choices: Next.js, SvelteKit, Rails, Something else.';

/** The bundled blueprint of this name, as its file says. */
export function bundled(name) {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../../packages/blueprints/data/blueprints/${name}.json`), 'utf8'));
}

/** Every row text a blueprint drafts, rules then questions, as SPEC.md carries them. */
export function draftedTexts(blueprint) {
  return [...blueprint.rules.map((rule) => `${rule.text} Why: ${rule.why}`),
    ...(blueprint.questions ?? []).map((question) => `${question.ask}: ${question.default ?? '(choose one)'}. Choices: ${question.choices.join(', ')}.`),
    ...(blueprint.defaults ?? []).map((entry) => entry.text)];
}

export const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Hash the fields the person's blueprint-fit reading binds, without importing the feature under test. */
export function fitDigest(proposal) {
  const { id, blueprint, kind, key, target, source, current, decision, text, reason, by } = proposal;
  return createHash('sha256').update(JSON.stringify({ id, blueprint, kind, key, target, source, current, decision, text, reason, by })).digest('hex');
}

/** Encode the reading's ordered ids, targets and digests as the short code the person approves. */
export function batchCode(reading) {
  const entries = reading.map((entry) => [entry?.id, entry?.target, entry?.digest]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/**
 * A web-app board in a plain node --test repo, committed, with one agent seat joined in its own
 * worktree. seat runs a command there as that agent's session; as runs one in the main checkout
 * with any agent session, or as the person when session is null.
 */
export function fitBoard() {
  const box = freshBoard({ lanes: { web: { owns: ['web/'] } } });
  writeFileSync(join(box.repo, 'package.json'), `${JSON.stringify({ name: 'lib', scripts: { test: 'node --test' } })}\n`);
  const added = json(box, 'blueprint', 'add', writeLegacyWebQuestions(box.repo, PUBLISHED));
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'chore: add the web-app blueprint');
  const worktree = join(box.dir, 'seat');
  box.git('worktree', 'add', '-q', worktree, '-b', 'web/fit');
  const as = (session, cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8',
    env: session ? { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session } : box.env });
  const seat = (...args) => as('fit-seat', worktree, ...args);
  const joined = seat('join', 'web', '--model', 'Fit Seat', '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const key = (name) => added.rows.find((row) => row.key === name).id;
  const starter = (name) => added.items.find((item) => item.key === name).id;
  return { box, worktree, seat, as, key, starter };
}

/** Run a command, require success, and return its JSON document. */
export function ok(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Run a command, require a refusal, and return its code. */
export function refusal(result, label) {
  assert.notEqual(result.status, 0, `${label} must be refused: ${result.stdout}`);
  return JSON.parse(result.stdout).error.code;
}


