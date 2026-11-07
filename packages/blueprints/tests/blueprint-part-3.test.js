/** @pullboard-test-input source-tree */
/** pullboard blueprint add: a blueprint lands on a board as drafts, once [S1,I1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../../test/fixture-child.js';
import { runFixtureGit } from '../../../test/fixture-child.js';
import { bundledBlueprints } from '../index.js';
import { readBlueprint } from '../index.js';
import { validateBlueprint } from '../index.js';
import { blueprintRowIds } from '../index.js';
import { starterStates } from '../index.js';
import { parseSpec } from '../../spec/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { assertStarterChecks } from '../../../test/blueprint-starter-fixture.js';
import { writeLegacyWebQuestions } from '../../../test/blueprint-question.fixture.js';
import { assertArchitectureBlueprintCoverage } from '../../../test/blueprint-architecture-coverage.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';
import { fixtureJoin } from '../../../test/testkit-fixture.js';

const BIN = resolve(import.meta.dirname, '../../../bin/pullboard.js');
const PUBLISHED = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/shell/blueprints/web-app.json'), 'utf8'));
const LEGACY_FRAMEWORK = { key: 'Q1', ask: 'The app is built with', choices: ['Next.js', 'SvelteKit', 'Rails', 'Something else'], detect: 'framework' };
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
const DIRS = [];

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity. */
function freshBoard(config = {}) {
  const { dir, repo, run, runIn, env } = emptyRepo();
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
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

/** Each pullboard.dev/blueprints card's title and rules, word for word, and how many things it asks the person. */
const GALLERY = {
  pullboard: { title: 'Pullboard, built on Pullboard', rules: ['A builder never verifies their own work.', "Every item's check fails before the change and passes after it.", 'Main only moves when the whole test suite passes.'], asks: 0 },
  website: { title: 'Website', rules: ['Every page reads in full with JavaScript turned off.', 'No change leaves a link pointing at a missing page.'], asks: 2 },
  'web-app': { title: 'Web app', rules: ['Every change ships with a test that fails without it.', 'Every page works at phone width before it ships.'], asks: 0 },
  library: { title: 'Open-source library', rules: ['A breaking change bumps the major version.', 'Every public function has a working example in the docs.'], asks: 2 },
  'ios-app': { title: 'iOS app', rules: ['Every screen has a light and a dark screenshot test.', 'No change removes a VoiceOver label from a screen.'], asks: 2 },
  serverless: { title: 'Serverless', rules: ['Every function has an alarm before it ships.', "No function runs past its platform's time limit."], asks: 3 },
  'data-pipeline': { title: 'Data pipeline', rules: ['A schema change ships with its migration.', 'A failed job names the rows and the reason.'], asks: 2 },
  'test-reliability': { title: 'Test reliability', rules: ['No test waits on the wall clock or a fixed sleep.', 'A flake is pinned on a change only after a run without it.'], asks: 1 },
  research: { title: 'Research board', rules: ['Every claim in a finding links to its source.', 'A finding counts only after a second agent rechecks its source.'], asks: 2 },
  writing: { title: 'Writing and blog', rules: ['Every fact in a post links to where it came from.', 'A post publishes only after you approve it.'], asks: 2 },
};

// A starter check ships to someone else's repo: it only runs the project's own tests, so it holds
// no deletion, download, install, remote shell, publish, redirect or command substitution.
const UNSAFE_CHECK = /\b(?:rm|curl|wget|sudo|ssh|scp|install|publish|push|deploy)\b|[>`]|\$\(/u;

/** An architecture blueprint whose rules name the reference each paraphrases; a fixture, never fetched. */
const SOURCED = {
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

/** A Git repository with history but no Pullboard yet, using the same private homes as freshBoard. */
function emptyRepo() {
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
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Blueprint fixture', GIT_AUTHOR_EMAIL: 'blueprint@example.invalid',
    GIT_COMMITTER_NAME: 'Blueprint fixture', GIT_COMMITTER_EMAIL: 'blueprint@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const runIn = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const run = (...args) => runIn(repo, ...args);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  return { dir, repo, run, runIn, env };
}

test('blueprint add files a blueprint as drafts and runs nothing it supplies [S1,I1]', () => {
  // A starter's check is stored on the item, but no check baseline starts: add executes nothing
  // from a blueprint, and says so. A blueprint is never read from a URL.
  const box = freshBoard({ gate: 'true' });
  const marker = join(box.dir, 'check-ran');
  const brief = 'Files:\n- web/index.html\nTest:\n- test/home.test.js asserts the page loads';
  const check = `touch '${marker}'`;
  writeFileSync(join(box.repo, 'checked.json'), `${JSON.stringify({ ...PUBLISHED, name: 'checked',
    items: [{ key: '1', title: 'Checked starter', cites: ['W1'], route: 'light', brief, criterion: 'The page loads.', check }] })}\n`);
  const added = json(box, 'blueprint', 'add', 'checked.json');
  const id = added.items[0].id;
  const item = json(box, 'show', String(id));
  assert.equal(item.item_check, check, 'the check is stored unchanged');
  assert.equal(item.item_check_baseline ?? null, null, 'no check baseline was started');
  assert.equal(existsSync(marker), false, 'the check command never ran');
  assert.deepEqual(added.checksNotRun, [id], 'the summary names the checks that were not run');
  const text = box.run('blueprint', 'add', 'checked.json');
  assert.match(text.stdout, /already on this board/u);
  for (const url of ['https://pullboard.dev/blueprints/web-app.json', 'file:///tmp/web-app.json']) {
    const refused = box.run('blueprint', 'add', url, '--json');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BLUEPRINT_URL');
  }
});

/** The text of the one pending row in the repo's SPEC.md whose question starts with the ask. */
function pendingQuestion(repo, ask) {
  const rows = parseSpec(readFileSync(join(repo, 'SPEC.md'), 'utf8')).rows.filter((row) => row.status === 'pending' && row.text.startsWith(`${ask}: `));
  assert.equal(rows.length, 1, `one pending "${ask}" row`);
  return rows[0].text;
}

const RUNNERS = 'Choices: node:test, Vitest, Jest, Mocha, pytest, Something else.';
const FRAMEWORKS = 'Choices: Next.js, SvelteKit, Rails, Something else.';

test('a question defaults from the repo it lands in [S1,I1]', () => {
  const runners = readBlueprint('test-reliability', import.meta.dirname).questions[0].choices;
  assert.ok(['node:test', 'Mocha', 'Vitest', 'Jest', 'pytest'].every((choice) => runners.includes(choice)), 'the test-runner question offers node:test and Mocha besides Vitest, Jest and pytest');

  // init --blueprint in a node --test project: the test runner is read from scripts.test.
  const node = emptyRepo();
  writeFileSync(join(node.repo, 'package.json'), `${JSON.stringify({ name: 'app', scripts: { test: 'node --test test/' } })}\n`);
  const started = node.run('init', '--blueprint', 'test-reliability');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(pendingQuestion(node.repo, 'Tests run with'), `Tests run with: node:test. ${RUNNERS}`, 'a node --test project defaults to node:test');

  // blueprint add in a Next.js project: the framework is read from dependencies.
  const next = freshBoard();
  writeFileSync(join(next.repo, 'package.json'), `${JSON.stringify({ name: 'web', dependencies: { next: '15.0.0', react: '19.0.0' } })}\n`);
  next.git('add', '-A');
  next.git('commit', '-q', '-m', 'chore: a Next.js app');
  writeFileSync(join(next.repo, 'framework.json'), JSON.stringify({ ...PUBLISHED, defaults: [], questions: [LEGACY_FRAMEWORK], items: [] }));
  json(next, 'blueprint', 'add', 'framework.json');
  assert.equal(pendingQuestion(next.repo, 'The app is built with'), `The app is built with: Next.js. ${FRAMEWORKS}`, 'a Next.js project defaults to Next.js');

  // No test script: one test runner among devDependencies is the answer.
  const mocha = freshBoard();
  writeFileSync(join(mocha.repo, 'package.json'), `${JSON.stringify({ name: 'lib', devDependencies: { mocha: '10.0.0' } })}\n`);
  mocha.git('add', '-A');
  mocha.git('commit', '-q', '-m', 'chore: a Mocha library');
  json(mocha, 'blueprint', 'add', 'test-reliability');
  assert.equal(pendingQuestion(mocha.repo, 'Tests run with'), `Tests run with: Mocha. ${RUNNERS}`, 'a devDependency names the test runner');

  // A detected answer the question does not offer is never used: the blueprint's own default stands.
  const narrow = { ...PUBLISHED, name: 'narrow', title: 'Narrow', prefix: 'NAR', items: [],
    defaults: [], questions: [{ key: 'Q1', ask: 'Its runner is', choices: ['Vitest', 'Jest'], default: 'Jest', detect: 'test-runner' }] };
  writeFileSync(join(mocha.repo, 'narrow.json'), `${JSON.stringify(narrow)}\n`);
  json(mocha, 'blueprint', 'add', 'narrow.json');
  assert.equal(pendingQuestion(mocha.repo, 'Its runner is'), 'Its runner is: Jest. Choices: Vitest, Jest.', 'an answer outside the choices is never used');
});

test('a question with nothing to read has no default [S1,I1]', () => {
  // No package.json at all, and one that names nothing a question asks about.
  const bare = emptyRepo();
  const started = bare.run('init', '--blueprint', 'test-reliability');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(pendingQuestion(bare.repo, 'Tests run with'), `Tests run with: (choose one). ${RUNNERS}`, 'no package.json leaves the test runner unanswered');
  const plain = freshBoard();
  writeFileSync(join(plain.repo, 'package.json'), `${JSON.stringify({ name: 'web', scripts: { test: 'make check' }, dependencies: { express: '5.0.0' } })}\n`);
  plain.git('add', '-A');
  plain.git('commit', '-q', '-m', 'chore: an app with nothing to read');
  writeFileSync(join(plain.repo, 'framework.json'), JSON.stringify({ ...PUBLISHED, defaults: [], questions: [LEGACY_FRAMEWORK], items: [] }));
  json(plain, 'blueprint', 'add', 'framework.json');
  assert.equal(pendingQuestion(plain.repo, 'The app is built with'), `The app is built with: (choose one). ${FRAMEWORKS}`, 'no known framework leaves the question unanswered');
  // A blueprint without a default for a question it cannot detect is valid and files the same way.
  const own = { ...PUBLISHED, name: 'own', title: 'Own', kind: 'practice', prefix: 'OWN', items: [], defaults: [], questions: [{ key: 'Q1', ask: 'Its colour is', choices: ['Red', 'Blue'] }] };
  writeFileSync(join(plain.repo, 'own.json'), `${JSON.stringify(own)}\n`);
  json(plain, 'blueprint', 'add', 'own.json');
  assert.equal(pendingQuestion(plain.repo, 'Its colour is'), 'Its colour is: (choose one). Choices: Red, Blue.');
});

test('starter items land in a build lane, never the coordinator lane [S1,I1]', () => {
  const lanesOf = (box) => (JSON.parse(box.run('list', '--all', '--json').stdout).items ?? []).map((item) => item.item_lane);
  const configLanes = (box) => JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes ?? {};

  // A fresh init with a blueprint: init proposes the app lane and the starters are filed in it.
  // The proposal stays unwritten until the agent runs the command init prints, then tells the person (#914).
  const fresh = emptyRepo();
  const started = fresh.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.deepEqual(lanesOf(fresh), Array(PUBLISHED.items.length).fill('app'), 'init files every starter in the lane it proposes');
  assert.match(started.stdout, /starter items filed in the app lane, proposed above; add it with the command printed there/u, 'init says the lane is a proposal');
  assert.match(started.stdout, /then tell the person which lanes you made: pullboard lane add app --owns app\//u, 'init prints the command that accepts it');
  assert.deepEqual(Object.keys(configLanes(fresh)).filter((name) => name === 'app'), [], 'the proposed lane is not written');
  const accepted = fresh.run('lane', 'add', 'app', '--owns', 'app/');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal((JSON.parse(fresh.run('list', 'app', '--json').stdout).items ?? []).length, PUBLISHED.items.length, 'once accepted, the lane lists its starters');

  // A board with a lane pullboard lane add made: starters go to it, and a starter's own lane is
  // kept when that lane exists. A coordinator or missing lane in the blueprint is never used.
  const laned = freshBoard();
  for (const [name, owns] of [['web', 'web/'], ['docs', 'docs/']]) {
    const made = laned.run('lane', 'add', name, '--owns', owns);
    assert.equal(made.status, 0, made.stdout + made.stderr);
  }
  const own = ['docs', 'no-such-lane', 'coordinator'];
  writeFileSync(join(laned.repo, 'own-lanes.json'), `${JSON.stringify({ ...PUBLISHED, name: 'own-lanes',
    items: PUBLISHED.items.map((item, index) => ({ ...item, lane: own[index] })) })}\n`);
  const placed = json(laned, 'blueprint', 'add', 'own-lanes.json');
  const placedLanes = placed.items.map((item) => item.lane);
  assert.equal(placedLanes[0], 'docs', 'a starter keeps its own lane when that lane exists');
  assert.equal(placedLanes[1], 'web', 'a starter naming a missing lane goes to the first lane pullboard lane add made');
  assert.equal(placedLanes[2], 'web', 'a blueprint\'s coordinator lane is never used');
  assert.deepEqual(placed.proposedLanes, [], 'nothing is proposed when a build lane exists');
  assert.deepEqual(lanesOf(laned).filter((lane) => lane === 'coordinator'), [], 'no starter lands in the coordinator lane');

  // A blueprint that names an existing lane owning no folders, a verifier lane: that lane builds
  // nothing, so every starter goes to the first build lane, and add says so.
  const verifier = freshBoard({ lanes: { tests: { owns: [] } } });
  const web = verifier.run('lane', 'add', 'web', '--owns', 'web/');
  assert.equal(web.status, 0, web.stdout + web.stderr);
  writeFileSync(join(verifier.repo, 'verifier-lane.json'), `${JSON.stringify({ ...PUBLISHED, name: 'verifier-lane',
    items: PUBLISHED.items.map((item) => ({ ...item, lane: 'tests' })) })}\n`);
  const moved = verifier.run('blueprint', 'add', 'verifier-lane.json');
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.deepEqual(lanesOf(verifier), Array(PUBLISHED.items.length).fill('web'), 'a starter naming a lane that owns no folders goes to the first build lane');
  assert.match(moved.stdout, /asked for the tests lane, which owns no folders, so (?:it is|they are) filed in the web lane/u, 'add says the named lane was not used');

  // A board with no build lane, only a verifier lane that owns no folders: blueprint add proposes
  // one, files the starters in it and says so.
  const bare = freshBoard({ lanes: { tests: { owns: [] } } });
  const before = readFileSync(join(bare.repo, 'pullboard.json'), 'utf8');
  const proposed = json(bare, 'blueprint', 'add', 'web-app');
  assert.deepEqual(proposed.items.map((item) => item.lane), Array(PUBLISHED.items.length).fill('app'), 'starters go to the proposed lane');
  assert.deepEqual(proposed.proposedLanes, [{ name: 'app', owns: ['app/'] }], 'the result names the proposal');
  assert.equal(JSON.parse(readFileSync(join(bare.repo, 'pullboard.json'), 'utf8')).lanes?.app, undefined, 'the proposal is not written');
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(bare.repo, 'pullboard.json'), 'utf8')).lanes), JSON.stringify(JSON.parse(before).lanes), 'pullboard.json keeps its lanes');
  const again = freshBoard();
  const said = again.run('blueprint', 'add', 'web-app');
  assert.equal(said.status, 0, said.stdout + said.stderr);
  assert.match(said.stdout, /starter items filed in the app lane, proposed; add it to start them/u, 'blueprint add says the lane is a proposal');
  assert.match(said.stdout, /then tell the person which lanes you made: pullboard lane add app --owns app\//u, 'blueprint add prints the command that accepts it');
});

/** The bundled blueprint of this name, as its file says. */
function bundled(name) {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, `../src/shell/blueprints/${name}.json`), 'utf8'));
}

/** Every row text a blueprint drafts, rules then questions, as SPEC.md carries them. */
function draftedTexts(blueprint) {
  return [...blueprint.rules.map((rule) => `${rule.text} Why: ${rule.why}`),
    ...(blueprint.questions ?? []).map((question) => `${question.ask}: ${question.default ?? '(choose one)'}. Choices: ${question.choices.join(', ')}.`),
    ...(blueprint.defaults ?? []).map((entry) => entry.text)];
}

test('init takes a product and an architecture blueprint together [S1,I1]', () => {
  const product = bundled('web-app');
  const architecture = bundled('serverless');
  // A practice blueprint that shares one rule with web-app and one question with serverless.
  const practice = { blueprint: 1, name: 'house-rules', title: 'House rules', version: 1, kind: 'practice', prefix: 'HR',
    rules: [product.rules[0], { key: 'HR1', text: 'Every change names the row it serves.', why: 'a reviewer reads the bar before the code.' }],
    questions: [architecture.questions[0]],
    items: [{ key: '1', title: 'Every commit cites a row', cites: [product.rules[0].key, 'HR1', architecture.questions[0].key], route: 'mid',
      criterion: 'Every commit names the spec row it serves; test/cites.test.js fails on one that does not.', brief: 'Files:\n- test/cites.test.js\nTest:\n- test/cites.test.js fails on a commit that cites no row', check: 'npm test -- test/cites.test.js' }] };
  const box = emptyRepo();
  const practiceFile = join(box.dir, 'house-rules.json');
  writeFileSync(practiceFile, `${JSON.stringify(practice)}\n`);

  const started = box.run('init', '--blueprint', 'web-app', '--blueprint', 'serverless', '--blueprint', practiceFile, '--json');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const result = JSON.parse(started.stdout);
  assert.deepEqual(result.blueprints.map((entry) => entry.name), ['web-app', 'serverless', 'house-rules'], 'every blueprint lands, in the order given');
  assert.equal(result.blueprint.name, 'web-app', 'the first blueprint keeps the single-blueprint field');

  // Rules from every blueprint are drafted in the order given, each in its own section.
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const spec = parseSpec(source);
  const sectionOf = (title) => spec.sections.findIndex((entry) => entry.name.endsWith(`· ${title}`));
  const order = [product, architecture, practice].map((blueprint) => sectionOf(blueprint.title));
  assert.ok(order.every((index) => index >= 0), `each blueprint has its own section: ${spec.sections.map((entry) => entry.name).join(', ')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections follow the order the blueprints were given');
  const rowsIn = (blueprint) => spec.rows.filter((row) => row.section === spec.sections[sectionOf(blueprint.title)].name);
  assert.deepEqual(rowsIn(product).map((row) => row.text), draftedTexts(product), 'the product blueprint drafts all its rows, in its order');
  assert.deepEqual(rowsIn(architecture).map((row) => row.text), draftedTexts(architecture), 'the architecture blueprint drafts all its rows, in its order');

  // A rule text two blueprints share is drafted once: the practice blueprint drafts only its own rule.
  assert.deepEqual(rowsIn(practice).map((row) => row.text), [`${practice.rules[1].text} Why: ${practice.rules[1].why}`], 'shared rows are not drafted again');
  for (const text of new Set([...draftedTexts(product), ...draftedTexts(architecture), ...draftedTexts(practice)])) {
    assert.equal(spec.rows.filter((row) => row.text === text).length, 1, `drafted once: ${text}`);
  }
  assert.ok(spec.rows.every((row) => row.status !== 'approved'), 'nothing is approved for the person');
  const sharedRule = rowsIn(product)[0].id;
  const sharedQuestion = rowsIn(architecture)[architecture.rules.length].id;
  assert.deepEqual(result.blueprints[2].shared.map((row) => row.id), [sharedRule, sharedQuestion], 'the result names the rows it shares');

  // Item detail reads need the initialized policy committed on the coordinator trunk.
  runFixtureGit(['add', '-A'], { cwd: box.repo, env: box.env });
  runFixtureGit(['commit', '-q', '-m', `feat(init): initialize blueprint fixture [${sharedRule}]`], { cwd: box.repo, env: box.env });

  // Starter items keep their blueprint name, and the shared starter cites the row already drafted.
  const items = JSON.parse(box.run('list', '--json').stdout).items ?? [];
  assert.equal(items.length, product.items.length + architecture.items.length + practice.items.length, 'every starter is filed once');
  const owner = (item) => {
    const note = json(box, 'show', String(item.item_id)).thread
      .find((entry) => entry.kind === 'note' && entry.text?.startsWith('blueprint starter: '));
    return note ? JSON.parse(note.text.slice('blueprint starter: '.length)).blueprint : null;
  };
  const byTitle = (title) => items.find((item) => item.item_title === title);
  for (const blueprint of [product, architecture, practice]) {
    for (const starter of blueprint.items) assert.equal(owner(byTitle(starter.title)), blueprint.name, `${starter.title} keeps its blueprint name`);
  }
  const own = rowsIn(practice)[0].id;
  assert.equal(byTitle(practice.items[0].title).item_spec_ids, [sharedRule, own, sharedQuestion].join(','), 'the shared starter cites the rows already drafted');

  const sharedProposal = json(box, 'blueprint', 'fit', practiceFile, sharedRule, 'keep');
  assert.deepEqual([sharedProposal.proposals[0].blueprint.name, sharedProposal.proposals[0].key, sharedProposal.proposals[0].target],
    ['house-rules', product.rules[0].key, sharedRule], 'a later blueprint can fit its shared row in the earlier section');
  const starterId = byTitle(practice.items[0].title).item_id;
  const starterProposal = json(box, 'blueprint', 'fit', practiceFile, `#${starterId}`, 'keep');
  assert.deepEqual([starterProposal.proposals[0].blueprint.name, starterProposal.proposals[0].target], ['house-rules', `#${starterId}`],
    'the later starter can fit when it cites that shared row');

  // blueprint add takes --blueprint more than once too, and each starter it files names its blueprint.
  const board = freshBoard();
  const added = json(board, 'blueprint', 'add', 'web-app', '--blueprint', 'serverless');
  assert.deepEqual(added.blueprints.map((entry) => entry.blueprint.name), ['web-app', 'serverless']);
  assert.deepEqual(added.items.map((item) => item.blueprint), [...product.items.map(() => 'web-app'), ...architecture.items.map(() => 'serverless')]);
  assert.equal(added.rows.length, draftedTexts(product).length + draftedTexts(architecture).length);
  assert.ok(added.rows.every((row) => ['draft', 'pending', 'fact'].includes(row.status)), 'rules and questions wait; defaults remain facts');
});

test('a second blueprint of the same kind is refused [S1,I1]', () => {
  // A second product blueprint: refused before anything is written, naming both.
  for (const [first, second, kind] of [['web-app', 'ios-app', 'product'], ['serverless', 'data-pipeline', 'architecture']]) {
    const box = emptyRepo();
    const refused = box.run('init', '--blueprint', first, '--blueprint', second, '--json');
    assert.notEqual(refused.status, 0, refused.stdout);
    const { error } = JSON.parse(refused.stdout);
    assert.equal(error.code, 'BLUEPRINT_KIND_TAKEN');
    assert.match(error.message, new RegExp(`${first} and ${second} are both ${kind} blueprints`, 'u'), 'the refusal names both');
    assert.deepEqual(readdirSync(box.repo).filter((name) => name !== '.git'), [], 'nothing is written');
    assert.equal(existsSync(join(box.repo, '.git', 'pullboard')), false, 'no board is created');
  }

  // blueprint add refuses the same way and leaves SPEC.md as it was.
  const board = freshBoard();
  const before = readFileSync(join(board.repo, 'SPEC.md'), 'utf8');
  const refused = board.run('blueprint', 'add', 'web-app', '--blueprint', 'website', '--json');
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.equal(JSON.parse(refused.stdout).error.code, 'BLUEPRINT_KIND_TAKEN');
  assert.match(JSON.parse(refused.stdout).error.message, /web-app and website are both product blueprints/u);
  assert.equal(readFileSync(join(board.repo, 'SPEC.md'), 'utf8'), before, 'SPEC.md is unchanged');

  // A board that already has a product blueprint refuses another in a later command, before any
  // write, whichever was added first; the same blueprint again changes nothing and is no clash.
  const listed = (box) => (JSON.parse(box.run('list', '--all', '--json').stdout).items ?? []).length;
  for (const [first, second] of [['web-app', 'other-product.json'], ['other-product.json', 'web-app']]) {
    const sequential = freshBoard();
    writeFileSync(join(sequential.repo, 'other-product.json'), `${JSON.stringify({ ...PUBLISHED, name: 'other-product', title: 'Other product' })}\n`);
    json(sequential, 'blueprint', 'add', first);
    const spec = readFileSync(join(sequential.repo, 'SPEC.md'), 'utf8');
    assert.ok(spec.includes(`<!-- pullboard-blueprint-kind ${first.replace(/\.json$/u, '')} product -->`), 'the add records its kind beside its rows');
    const items = listed(sequential);
    const later = sequential.run('blueprint', 'add', second, '--json');
    assert.notEqual(later.status, 0, later.stdout);
    assert.equal(JSON.parse(later.stdout).error.code, 'BLUEPRINT_KIND_TAKEN');
    assert.match(JSON.parse(later.stdout).error.message, /(?=.*web-app)(?=.*other-product)/u, 'the refusal names both');
    assert.equal(readFileSync(join(sequential.repo, 'SPEC.md'), 'utf8'), spec, 'a later second product writes no row');
    assert.equal(listed(sequential), items, 'a later second product files no starter');
    assert.equal(json(sequential, 'blueprint', 'add', first).marked, true, 'the same blueprint again is a no-op');
    assert.equal(readFileSync(join(sequential.repo, 'SPEC.md'), 'utf8'), spec);
    assert.equal(json(sequential, 'blueprint', 'add', 'serverless').blueprint.name, 'serverless', 'an architecture blueprint still joins a product one later');
  }
  // A board an older Pullboard set up: each blueprint's marker with no kind line. That Pullboard
  // wrote exactly today's add without the kind line, byte for byte, so the fixture is that (#720).
  const legacyAdd = (box, file) => {
    json(box, 'blueprint', 'add', file);
    const path = join(box.repo, 'SPEC.md');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((line) => !line.startsWith('<!-- pullboard-blueprint-kind ')).join('\n'));
    assert.doesNotMatch(readFileSync(path, 'utf8'), /pullboard-blueprint-kind/u);
  };
  const refusedBoth = (box, first, second, args) => {
    const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
    const items = listed(box);
    const later = box.run('blueprint', 'add', ...args, '--json');
    assert.notEqual(later.status, 0, later.stdout);
    const { error } = JSON.parse(later.stdout);
    assert.equal(error.code, 'BLUEPRINT_KIND_TAKEN');
    assert.match(error.message, new RegExp(`^${first} and ${second} `, 'u'), 'the refusal names both');
    assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, 'SPEC.md is unchanged');
    assert.equal(listed(box), items, 'no starter is filed');
    return error;
  };
  const custom = (box, name, kind, where) => {
    const file = join(where, `${name}.json`);
    writeFileSync(file, `${JSON.stringify({ ...PUBLISHED, name, title: name, kind })}\n`);
    return file;
  };
  // A custom product whose file is gone from the repo: its kind is unknown, so another product is
  // refused, naming both, with the step that records the kind. Adding its file again records it
  // and nothing else; a product is still refused after, and an architecture blueprint joins it.
  const away = freshBoard();
  const awayFile = custom(away, 'legacy-product', 'product', away.dir);
  legacyAdd(away, awayFile);
  const unknown = refusedBoth(away, 'legacy-product', 'web-app', ['web-app']);
  assert.match(unknown.next, /record legacy-product's kind with pullboard blueprint add/u, 'the next step says how to resolve it');
  const beforeRecord = readFileSync(join(away.repo, 'SPEC.md'), 'utf8');
  const items = listed(away);
  assert.equal(json(away, 'blueprint', 'add', awayFile).marked, true, 'adding its file again adds nothing');
  const recorded = readFileSync(join(away.repo, 'SPEC.md'), 'utf8');
  assert.deepEqual(recorded.split('\n').filter((line) => !beforeRecord.split('\n').includes(line)), ['<!-- pullboard-blueprint-kind legacy-product product -->'], 'it records only the kind');
  assert.equal(listed(away), items);
  refusedBoth(away, 'legacy-product', 'web-app', ['web-app']);
  assert.equal(json(away, 'blueprint', 'add', 'serverless').blueprint.name, 'serverless', 'an architecture blueprint joins the recorded product');
  // A custom product whose file is still at the repo root: its kind is read from it.
  const home = freshBoard();
  legacyAdd(home, custom(home, 'legacy-product', 'product', home.repo));
  assert.match(refusedBoth(home, 'legacy-product', 'web-app', ['web-app']).message, /are both product blueprints/u);
  // A custom practice blueprint: once its kind is recorded, a product joins it.
  const practiced = freshBoard();
  const practiceFile = custom(practiced, 'legacy-practice', 'practice', practiced.dir);
  legacyAdd(practiced, practiceFile);
  refusedBoth(practiced, 'legacy-practice', 'web-app', ['web-app']);
  json(practiced, 'blueprint', 'add', practiceFile);
  assert.equal(json(practiced, 'blueprint', 'add', 'web-app').blueprint.name, 'web-app', 'a product joins a recorded practice blueprint');
  // A bundled product from an older Pullboard is read from its bundled file; adding it again is a
  // no-op apart from recording its kind.
  const bundledLegacy = freshBoard();
  writeFileSync(join(bundledLegacy.repo, 'other-product.json'), `${JSON.stringify({ ...PUBLISHED, name: 'other-product', title: 'Other product' })}\n`);
  legacyAdd(bundledLegacy, 'web-app');
  refusedBoth(bundledLegacy, 'web-app', 'other-product', ['other-product.json']);
  const bundledItems = listed(bundledLegacy);
  assert.equal(json(bundledLegacy, 'blueprint', 'add', 'web-app').marked, true, 'the same bundled blueprint again adds nothing');
  assert.equal(listed(bundledLegacy), bundledItems);

  const reinit = emptyRepo();
  const once = reinit.run('init', '--blueprint', 'web-app');
  assert.equal(once.status, 0, once.stdout + once.stderr);
  const initSpec = readFileSync(join(reinit.repo, 'SPEC.md'), 'utf8');
  const second = reinit.run('init', '--blueprint', 'ios-app', '--json');
  assert.notEqual(second.status, 0, second.stdout);
  assert.equal(JSON.parse(second.stdout).error.code, 'BLUEPRINT_KIND_TAKEN');
  assert.match(JSON.parse(second.stdout).error.message, /web-app and ios-app are both product blueprints/u);
  assert.equal(readFileSync(join(reinit.repo, 'SPEC.md'), 'utf8'), initSpec, 'a later init with a second product writes no row');
  const again = reinit.run('init', '--blueprint', 'web-app');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(join(reinit.repo, 'SPEC.md'), 'utf8'), initSpec, 'init with the same blueprint again changes no row');

  // Any number of practice and beyond-code blueprints sit beside one product and one architecture.
  const many = emptyRepo();
  const names = ['web-app', 'serverless', 'test-reliability', 'research', 'writing'];
  const landed = many.run('init', ...names.flatMap((name) => ['--blueprint', name]), '--json');
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.deepEqual(JSON.parse(landed.stdout).blueprints.map((entry) => entry.name), names);
});

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Hash the fields the person's blueprint-fit reading binds, without importing the feature under test. */
function fitDigest(proposal) {
  const { id, blueprint, kind, key, target, source, current, decision, text, reason, by } = proposal;
  return createHash('sha256').update(JSON.stringify({ id, blueprint, kind, key, target, source, current, decision, text, reason, by })).digest('hex');
}

/** Encode the reading's ordered ids, targets and digests as the short code the person approves. */
function batchCode(reading) {
  const entries = reading.map((entry) => [entry?.id, entry?.target, entry?.digest]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/**
 * A web-app board in a plain node --test repo, committed, with one agent seat joined in its own
 * worktree. seat runs a command there as that agent's session; as runs one in the main checkout
 * with any agent session, or as the person when session is null.
 */
function fitBoard() {
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
function ok(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Run a command, require a refusal, and return its code. */
function refusal(result, label) {
  assert.notEqual(result.status, 0, `${label} must be refused: ${result.stdout}`);
  return JSON.parse(result.stdout).error.code;
}


