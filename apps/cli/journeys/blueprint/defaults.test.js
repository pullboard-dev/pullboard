/** Web-app defaults are editable facts, never day-zero questions [S1,I1,C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { readBlueprint } from '../../../../packages/blueprints/index.js';
import { validateBlueprint } from '../../../../packages/blueprints/index.js';
import { waitingRows } from '../../../../packages/blueprints/index.js';
import { blueprintRowIds } from '../../../../packages/blueprints/index.js';
import { fitTargets } from '../../../../packages/blueprints/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
const DIRS = [];
after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity. */
function freshBoard(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-'));
  DIRS.push(dir);
  // The hooks init installs call pullboard by name, so this checkout's CLI is the one on PATH.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || MARKERS.includes(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Blueprint fixture', GIT_AUTHOR_EMAIL: 'blueprint@example.invalid',
    GIT_COMMITTER_NAME: 'Blueprint fixture', GIT_COMMITTER_EMAIL: 'blueprint@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const runIn = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const run = (...args) => runIn(repo, ...args);
  git('init', '-q', '-b', 'main');
  const init = run('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const file = join(repo, 'pullboard.json');
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...config }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up blueprint fixture');
  return { dir, repo, run, runIn, git, env };
}

/** Run one command with --json and return its document, failing with its output. */
function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('web-app applies four editable defaults without questions or placeholder approvals [S1,I1,C7]', () => {
  const box = freshBoard();
  const added = json(box, 'blueprint', 'add', 'web-app');
  const blueprint = readBlueprint('web-app');
  assert.deepEqual(blueprint.questions, []);
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const spec = parseSpec(source);
  assert.deepEqual(spec.problems, []);
  const facts = added.rows.filter((row) => row.status === 'fact');
  assert.deepEqual(facts.map((row) => [row.key, row.text]), [
    ['Q1', 'Runs on: Node.js.'],
    ['Q2', 'Hosting: Free; provider undecided.'],
    ['Q3', 'Sign-in: Built in; no outside accounts needed.'],
    ['Q4', 'Done means: Tests pass.'],
  ]);
  assert.equal(added.rows.filter((row) => row.status === 'pending').length, 0);
  assert.equal(added.rows.filter((row) => row.status === 'approved').length, 0);
  const waiting = waitingRows(added.rows, { rows: [] }, 'SPEC.md');
  assert.equal(waiting.length, 7, 'ordinary rules still wait for approval');
  assert.ok(waiting.every((row) => row.status === 'draft'));
  assert.ok(spec.rows.every((row) => !row.text.includes('The first thing the client needs, in one line.')), 'the fenced placeholder never becomes a row');
  assert.doesNotMatch(JSON.stringify(added), /Next\.js|Vercel|Google|Cloudflare|Choices:/u);
  const ids = blueprintRowIds(blueprint, spec, source);
  for (const fact of facts) assert.equal(ids[fact.key], fact.id);
  const items = json(box, 'list', '--all').items;
  const targets = fitTargets(blueprint, spec, items);
  for (const fact of facts) assert.equal(targets.has(fact.id), false, 'facts are not approval proposals');
  assert.ok(targets.has(`#${added.items[2].id}`), 'starter citations still resolve through defaults');
  // A person can edit the selected setting without approving a new requirement.
  const edited = source.replace('Hosting: Free; provider undecided.', 'Hosting: Free; provider chosen later.');
  writeFileSync(join(box.repo, 'SPEC.md'), edited);
  const repeat = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(repeat.rows, []);
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), edited, 'repeat intake preserves the edited default');
  assert.equal(parseSpec(edited).rows.find((row) => row.id === facts[1].id).status, 'fact');
});

test('explicit question templates still ask and validate defaults independently [S1,I1]', () => {
  const box = freshBoard();
  const custom = { blueprint: 1, name: 'questions', title: 'Questions', version: 1,
    questions: [{ key: 'Q1', ask: 'Its colour is', choices: ['Red', 'Blue'], default: 'Blue' }] };
  writeFileSync(join(box.repo, 'questions.json'), JSON.stringify(custom));
  const added = json(box, 'blueprint', 'add', 'questions.json');
  assert.deepEqual(added.rows.map((row) => [row.status, row.text]), [['pending', 'Its colour is: Blue. Choices: Red, Blue.']]);
  assert.equal(waitingRows(added.rows, { rows: [] }, 'SPEC.md').length, 1);
  assert.throws(() => validateBlueprint({ ...custom, defaults: [{ key: 'Q1', text: 'Duplicate.' }] }), /repeats the key/u);
  assert.throws(() => validateBlueprint({ ...custom, defaults: [{ key: 'D1', text: 'bad|row' }] }), /one line without/u);
});


test('init counts only real obligations and never lists defaults for approval [S1,I1,C7]', () => {
  const box = freshBoard();
  const started = json(box, 'init', '--blueprint', 'web-app');
  assert.equal(started.blueprint.waiting, 7);
  assert.ok(started.blueprint.waitingRows.every((row) => ['draft', 'pending'].includes(row.status)));
  assert.ok(started.blueprint.waitingRows.every((row) => !/Runs on:|Hosting:|Sign-in:|Done means:|The first thing the client needs/u.test(row.text)));
  const spec = parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'));
  assert.equal(spec.rows.filter((row) => row.status === 'fact').length, 4);
});
