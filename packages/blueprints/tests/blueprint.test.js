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

test('blueprint add files a blueprint as drafts [S1,I1]', () => {
  // A fresh board: one new section, rules as drafts with reasons, questions as pending rows with defaults.
  const box = freshBoard();
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(added.blueprint, { name: 'web-app', title: 'Web app', version: 1 });
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.ok(source.startsWith(before.trimEnd()), 'the existing spec text is kept as it was');
  const spec = parseSpec(source);
  assert.deepEqual(spec.problems, []);
  const section = spec.sections.filter((entry) => entry.name.endsWith('· Web app'));
  assert.equal(section.length, 1, 'one section named after the blueprint');
  assert.equal(added.section, section[0].name);
  const rows = spec.rows.filter((row) => row.section === section[0].name);
  assert.equal(rows.length, 11, '7 rules and 4 defaults');
  assert.equal(spec.rows.filter((row) => row.status === 'approved').length, 0, 'nothing is approved');
  const rules = rows.filter((row) => row.status === 'draft');
  assert.deepEqual(rules.map((row) => row.text), PUBLISHED.rules.map((rule) => `${rule.text} Why: ${rule.why}`));
  assert.equal(rules[0].text, 'Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.');
  assert.deepEqual(rows.filter((row) => row.status === 'pending'), []);
  assert.deepEqual(rows.filter((row) => row.status === 'fact').map((row) => row.text), PUBLISHED.defaults.map((entry) => entry.text));
  const ids = Object.fromEntries(added.rows.map((row) => [row.key, row.id]));
  assert.deepEqual(added.rows.map((row) => row.id), rows.map((row) => row.id));
  const doctrine = parseSpec(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8'));
  for (const row of rows) assert.ok(!doctrine.rows.some((entry) => entry.id === row.id), `${row.id} is unique across SPEC.md and DOCTRINE.md`);
  const check = box.run('spec', 'check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(rows.some(({ id }) => (check.stdout + check.stderr).split('\n').some((line) => line.includes(` ${id} warning: `) && line.includes('words; rows stay under'))), false, 'a reason or the choices do not count toward the blueprint row length');

  // Starter items: open, citing the new rows, the third waiting on the first.
  const items = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.deepEqual(items.map((item) => [item.item_title, item.item_status, item.item_spec_ids, item.item_after]), [
    ['Set up the test runner with one passing test', 'open', `${ids.W1},${ids.W2}`, ''],
    ['The home page works at phone width', 'open', ids.W3, ''],
    ['Every change gets a preview link', 'open', `${ids.Q2},${ids.Q4}`, String(items[0].item_id)],
  ]);
  assert.equal(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).gate, 'npm test', 'the gate is set when there was none');

  // A repeat adds nothing twice: no rows, no items, the same files.
  const specAfter = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const configAfter = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  const repeat = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual([repeat.rows, repeat.items, repeat.gate], [[], [], null]);
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specAfter);
  assert.equal(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'), configAfter);
  assert.equal(json(box, 'list', '--all').items.length, 3);
  const text = box.run('blueprint', 'add', 'web-app');
  assert.match(text.stdout, /already on this board; nothing added/u);

  // A bad file is refused with its problems named, and changes nothing.
  writeFileSync(join(box.repo, 'bad.json'), `${JSON.stringify({ ...PUBLISHED, name: 'Bad Name', items: [{ key: '1', title: 'x', cites: ['Z9'] }] })}\n`);
  const bad = box.run('blueprint', 'add', 'bad.json', '--json');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const error = JSON.parse(bad.stdout).error;
  assert.equal(error.code, 'BAD_BLUEPRINT');
  assert.match(error.message, /name must be lowercase/u);
  assert.match(error.message, /items\[0\]\.cites names "Z9"/u);
  writeFileSync(join(box.repo, 'broken.json'), '{ "blueprint": 1,');
  const broken = box.run('blueprint', 'add', 'broken.json', '--json');
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).error.code, 'BAD_BLUEPRINT');
  const missing = box.run('blueprint', 'add', 'no-such-blueprint', '--json');
  assert.equal(JSON.parse(missing.stdout).error.code, 'NO_BLUEPRINT');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specAfter, 'refusals leave the spec alone');
  assert.equal(json(box, 'list', '--all').items.length, 3, 'refusals add no items');

  // A board that already has a gate keeps it.
  const gated = freshBoard({ gate: 'node --test' });
  json(gated, 'blueprint', 'add', 'web-app');
  assert.equal(JSON.parse(readFileSync(join(gated.repo, 'pullboard.json'), 'utf8')).gate, 'node --test');
});

test('blueprint add files a blueprint as drafts even when approved rows say the same [S1,I1]', () => {
  // Rows elsewhere in the spec, approved, with a rule's exact text and a question's prompt: the
  // blueprint still files every rule as a draft and every question as a pending row of its own.
  const box = freshBoard();
  const file = join(box.repo, 'SPEC.md');
  const rule = `${PUBLISHED.rules[0].text} Why: ${PUBLISHED.rules[0].why}`;
  writeFileSync(file, readFileSync(file, 'utf8').replace('## G · Goals: what the client asked for\n',
    `## G · Goals: what the client asked for\n- G1 [approved, must] ${rule} | gate: review\n- G2 [approved, must] ${LEGACY_FRAMEWORK.ask}: Rails. Choices: Rails. | gate: review\n`));
  box.git('commit', '-q', '-am', 'chore: approve two rows first');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(added.rows.map((row) => row.status), [...Array(7).fill('draft'), ...Array(4).fill('fact')]);
  const spec = parseSpec(readFileSync(file, 'utf8'));
  const own = spec.rows.filter((row) => row.section === added.section);
  assert.equal(own.length, 11, 'the blueprint section holds all its own rows');
  assert.deepEqual(spec.rows.filter((row) => row.status === 'approved').map((row) => row.id), ['G1', 'G2'], 'the approved rows are untouched');
  const items = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.equal(items[0].item_spec_ids, `${added.rows[0].id},${added.rows[1].id}`, 'starter items cite the blueprint rows, not the approved ones');
});

test('blueprint add files a blueprint as drafts or nothing at all [S1,I1]', () => {
  const box = freshBoard();
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const config = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  /** Write a variant of the published blueprint and add it, returning the refusal. */
  const refused = (name, items) => {
    writeFileSync(join(box.repo, `${name}.json`), `${JSON.stringify({ ...PUBLISHED, name, items })}\n`);
    const result = box.run('blueprint', 'add', `${name}.json`, '--json');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, `${name}: nothing is written to the spec`);
    assert.equal(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'), config, `${name}: the gate is left alone`);
    assert.equal(json(box, 'list', '--all').items.length, 0, `${name}: no item is added`);
    return JSON.parse(result.stdout).error;
  };
  // Every starter carries a criterion and a check, so each refusal below is the board's own.
  const bar = { criterion: 'A test fails without the change.', check: 'true' };
  // A later starter the board refuses (here a brief over its limit) stops the add before any write.
  const late = refused('late-refusal', [{ key: '1', title: 'First starter', cites: ['W1'], ...bar }, { key: '2', title: 'Second starter', brief: 'x'.repeat(8001), ...bar }]);
  assert.equal(late.code, 'BRIEF_TOO_LONG');
  // A light or mid starter without what pullboard add requires is refused with add's own refusal.
  for (const route of ['light', 'mid']) {
    const error = refused(`${route}-route`, [{ key: '1', title: 'First starter', cites: ['W1'], ...bar }, { key: '2', title: 'Second starter', route, ...bar }]);
    assert.equal(error.code, 'NO_BRIEF');
    // A light starter is filed mid, so add names the mid route it was refused on.
    assert.match(error.message, new RegExp(`an item routed ${route === 'light' ? 'mid' : route} must be buildable cold`, 'u'));
  }
  // After the refusals, the same blueprint fixed adds everything at once.
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(added.rows.length, 11);
  assert.equal(added.items.length, 3);
});

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

test('every gallery blueprint is bundled and valid [S1]', () => {
  assert.deepEqual(bundledBlueprints(), Object.keys(GALLERY).sort(), 'the bundled blueprints are exactly the gallery cards');
  for (const [name, card] of Object.entries(GALLERY)) {
    const blueprint = readBlueprint(name, process.cwd());
    assert.equal(blueprint.name, name);
    assert.equal(blueprint.title, card.title, `${name} carries its card's title`);
    assert.equal(blueprint.by, 'Pullboard', `${name} is made by Pullboard, not a client or private project`);
    const texts = blueprint.rules.map((rule) => rule.text);
    for (const rule of card.rules) assert.ok(texts.includes(rule), `${name} holds its card's rule word for word: ${rule}`);
    for (const rule of blueprint.rules) assert.ok(rule.why.trim().length > 10, `${name} ${rule.key} gives a reason`);
    assert.ok(blueprint.questions.length >= card.asks, `${name} asks at least what its card says it asks`);
  }
});

// A starter check ships to someone else's repo: it only runs the project's own tests, so it holds
// no deletion, download, install, remote shell, publish, redirect or command substitution.
const UNSAFE_CHECK = /\b(?:rm|curl|wget|sudo|ssh|scp|install|publish|push|deploy)\b|[>`]|\$\(/u;

test('every bundled starter item carries a criterion and a check [S1,I1]', () => {
  // Every bundled blueprint files at least one starter, and each carries a criterion and a check.
  for (const name of bundledBlueprints()) {
    const blueprint = readBlueprint(name, process.cwd());
    assert.ok(blueprint.items.length >= 1, `${name} files at least one starter item`);
    for (const item of blueprint.items) {
      assert.ok(item.criterion.trim(), `${name} starter ${item.key} carries a criterion`);
      assert.ok(String(item.check ?? '').trim(), `${name} starter ${item.key} carries a check`);
      assert.doesNotMatch(item.check, UNSAFE_CHECK, `${name} starter ${item.key} only runs the project's own tests`);
    }
  }
  const flaky = readBlueprint('test-reliability', process.cwd()).items;
  assert.ok(flaky.some((item) => /flaky/u.test(item.title) && /repeated runs/u.test(item.criterion) && /deterministic/u.test(item.title)),
    'test-reliability files one: find a flaky test by repeated runs, then make it deterministic');

  // blueprint add files every bundled starter with its criterion and check, stored and never run.
  // A board takes one product and one architecture blueprint (#720), so each goes to the first
  // board that has room for its kind.
  const boards = [];
  for (const name of bundledBlueprints()) {
    const kind = readBlueprint(name, process.cwd()).kind;
    const single = ['product', 'architecture'].includes(kind);
    let board = boards.find((entry) => !single || !entry.kinds.has(kind));
    if (!board) boards.push(board = { box: freshBoard({ gate: 'true' }), kinds: new Set(), expected: [] });
    if (single) board.kinds.add(kind);
    const added = json(board.box, 'blueprint', 'add', name);
    const items = readBlueprint(name, process.cwd()).items;
    assert.equal(added.items.length, items.length, `${name} files every starter`);
    assert.deepEqual(added.checksNotRun, added.items.map((item) => item.id), `${name}: every check is stored, none run`);
    board.expected.push(...items.map((item) => [item.title, item.criterion, `cd './app' && (${item.check})`]));
  }
  for (const { box, expected } of boards) {
    const filed = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
    assert.deepEqual(filed.map((item) => [item.item_title, item.item_criterion, item.item_check]), expected);
    assert.ok(filed.every((item) => (item.item_check_baseline ?? null) === null), 'no check baseline ran');
  }

  // init --blueprint files them with both and prints that the checks are stored, not run.
  const web = readBlueprint('web-app', process.cwd());
  const fresh = emptyRepo();
  const started = fresh.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const startedItems = (JSON.parse(fresh.run('list', '--json').stdout).items ?? []).sort((a, b) => a.item_id - b.item_id);
  assert.deepEqual(startedItems.map((item) => [item.item_title, item.item_criterion, item.item_check]), web.items.map((item) => [item.title, item.criterion, `cd './app' && (${item.check})`]));
  assert.match(started.stdout, new RegExp(`checks stored, not run: ${startedItems.map((item) => `#${item.item_id}`).join(', ')}; no check baseline ran`, 'u'));
});

test('blueprint add files a blueprint as drafts only from the coordinator, who sets checks [S1,I1]', () => {
  // A bundled starter carries a check and only the coordinator sets one: an agent in a lane is
  // refused before anything is written and told to add it from the main checkout.
  const box = freshBoard({ lanes: { web: { owns: ['web/'] } } });
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const worktree = join(box.dir, 'web');
  box.git('worktree', 'add', '-q', worktree, '-b', 'web/starter');
  const joined = fixtureJoin(box.runIn, worktree, 'web', '--model', 'fixture-model');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const refused = box.runIn(worktree, 'blueprint', 'add', 'web-app', '--json');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'COORDINATOR_CHECK');
  assert.match(error.message, /web-app blueprint's starter items carry checks/u);
  assert.match(error.next, /from the main checkout/u);
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, 'nothing is written');
  assert.equal(json(box, 'list', '--all').items.length, 0, 'no item is filed');
  assert.equal(json(box, 'blueprint', 'add', 'web-app').items.length, 3, 'the coordinator adds it');
});

test('a starter item without a check is refused [S1,I1]', () => {
  // Loaded from a file or checked before a save writes one: a starter without a criterion or a
  // check is refused by name, the blueprint's and the item's.
  const starter = { key: '2', title: 'Second starter', cites: ['W1'], criterion: 'A test fails without it.', check: 'npm test' };
  const cases = [
    ['no-check', { ...starter, check: undefined }, /no check/u],
    ['blank-check', { ...starter, check: '   ' }, /no check/u],
    ['no-criterion', { ...starter, criterion: undefined }, /no criterion/u],
  ];
  const box = freshBoard();
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  for (const [name, item, why] of cases) {
    const value = { ...PUBLISHED, name, items: [PUBLISHED.items[0], item] };
    assert.throws(() => validateBlueprint(value, `${name}.json`), (error) => {
      assert.equal(error.code, 'BLUEPRINT_ITEM_UNCHECKED');
      assert.match(error.message, new RegExp(`blueprint ${name} starter item 2 \\("Second starter"\\)`, 'u'));
      assert.match(error.message, why);
      return true;
    });
    writeFileSync(join(box.repo, `${name}.json`), `${JSON.stringify(value)}\n`);
    const refused = box.run('blueprint', 'add', `${name}.json`, '--json');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'BLUEPRINT_ITEM_UNCHECKED');
    assert.match(error.message, new RegExp(`blueprint ${name} starter item 2`, 'u'));
  }
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, 'a refused blueprint writes nothing');
  assert.equal(json(box, 'list', '--all').items.length, 0, 'and files no item');

  // init --blueprint refuses it before writing anything.
  const outside = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-unchecked-'));
  DIRS.push(outside);
  writeFileSync(join(outside, 'unchecked.json'), JSON.stringify({ ...PUBLISHED, name: 'unchecked', items: [{ ...starter, check: undefined }] }));
  const empty = emptyRepo();
  const init = empty.run('init', '--blueprint', join(outside, 'unchecked.json'), '--json');
  assert.notEqual(init.status, 0);
  assert.equal(JSON.parse(init.stdout).error.code, 'BLUEPRINT_ITEM_UNCHECKED');
  assert.deepEqual(readdirSync(empty.repo).filter((entry) => entry !== '.git'), [], 'init writes nothing');
});

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
test("an architecture blueprint's rows each arrive with a check that runs red before it is built [S1,I1]", () => {
  assertArchitectureBlueprintCoverage({ blueprint: { ...SOURCED, items: [
    { key: '1', title: 'Add an alarm', cites: ['EA1'], criterion: 'The alarm is present.', check: 'test -f app/src/alarm.js' },
    { key: '2', title: 'Set a deadline', cites: ['EA2'], criterion: 'The deadline is set.', check: 'test -f app/src/deadline.js' },
  ] }, freshBoard, json, runFixtureChild });
});
test('a drafted row records its rule source [S1,I1]', () => {
  // blueprint add copies each rule's source onto its drafted row as a source field; the row's text
  // stays the rule and its reason, so the person approves the rule and reads where it came from.
  const box = freshBoard({ gate: 'true' });
  writeFileSync(join(box.repo, 'edge-api.json'), `${JSON.stringify(SOURCED)}\n`);
  const added = json(box, 'blueprint', 'add', 'edge-api.json');
  const drafted = added.rows.filter((row) => row.status === 'draft');
  assert.deepEqual(drafted.map((row) => [row.key, row.source]), [['EA1', 'Example Framework OPS 8 https://example.com/framework/ops-8'], ['EA2', 'Example Lens']]);
  assert.equal(added.rows.find((row) => row.key === 'Q1').source, undefined, 'a question names no source');
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const ea1 = drafted[0].id;
  assert.ok(source.split('\n').includes(`- ${ea1} [draft, must] Every function has an error alarm. Why: a quiet failure is found by users first. | gate: review | source: Example Framework OPS 8 https://example.com/framework/ops-8`), source);
  const spec = parseSpec(source);
  assert.deepEqual(spec.problems, []);
  const row = spec.rows.find((entry) => entry.id === ea1);
  assert.equal(row.text, 'Every function has an error alarm. Why: a quiet failure is found by users first.', 'the source is a field, not part of the text');
  assert.equal(row.source, 'Example Framework OPS 8 https://example.com/framework/ops-8');

  // pullboard spec shows where the row came from: spec check passes, its JSON rows carry the
  // source, and spec show prints it.
  const check = box.run('spec', 'check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const rows = json(box, 'spec', '--json').rows;
  assert.equal(rows.find((entry) => entry.id === ea1).source, 'Example Framework OPS 8 https://example.com/framework/ops-8');
  const shown = box.run('spec', 'show', ea1);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /^source: Example Framework OPS 8 https:\/\/example\.com\/framework\/ops-8$/mu);
  assert.equal(json(box, 'spec', 'show', ea1).row.source, 'Example Framework OPS 8 https://example.com/framework/ops-8');

  // A row with no source parses exactly as before: no source key, and spec show prints none. An
  // empty source field is an error spec check names.
  const plain = rows.find((entry) => entry.status === 'pending');
  assert.equal(Object.hasOwn(plain, 'source'), false, 'a row without a source carries no source key');
  assert.deepEqual(Object.keys(parseSpec('# S\n\n## G · Goals\n\n- G1 [draft, must] A row. | gate: review\n').rows[0]),
    ['id', 'status', 'tier', 'text', 'gate', 'serves', 'signers', 'unknown', 'section', 'line'], 'an older row parses unchanged');
  assert.doesNotMatch(box.run('spec', 'show', plain.id).stdout, /^source:/mu);
  writeFileSync(join(box.repo, 'SPEC.md'), source.replace(' | source: Example Lens', ' | source: '));
  const empty = box.run('spec', 'check');
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.match(empty.stdout, /source names where the row came from/u);
  writeFileSync(join(box.repo, 'SPEC.md'), source);

  // A bundled architecture blueprint drafts its rows with the source it names, on a board of its
  // own, since this one already has an architecture blueprint (#720).
  const serverless = json(freshBoard({ gate: 'true' }), 'blueprint', 'add', 'serverless');
  for (const rule of readBlueprint('serverless', process.cwd()).rules) {
    const drafted = serverless.rows.find((entry) => entry.key === rule.key);
    assert.equal(drafted.source, `${rule.source.name} ${rule.source.id} ${rule.source.url}`, `serverless ${rule.key} keeps its source`);
  }

  // init --blueprint drafts the same rows with the same sources.
  const fresh = emptyRepo();
  writeFileSync(join(box.dir, 'edge-api.json'), `${JSON.stringify(SOURCED)}\n`);
  const started = fresh.run('init', '--blueprint', join(box.dir, 'edge-api.json'));
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const initRows = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.filter((entry) => entry.status === 'draft');
  assert.deepEqual(initRows.map((entry) => entry.source), ['Example Framework OPS 8 https://example.com/framework/ops-8', 'Example Lens']);
});

test('an architecture rule without a source is refused [S1,I1]', () => {
  // Loaded from a file or checked before a save writes one: an architecture blueprint with a rule
  // that names no source is refused by name, the blueprint's and the rule's.
  const unsourced = { ...SOURCED, rules: [SOURCED.rules[0], { key: 'EA2', text: 'No function runs past its time limit.', why: 'the platform stops it there.' }] };
  for (const kind of ['architecture', 'infrastructure']) {
    assert.throws(() => validateBlueprint({ ...unsourced, kind }, 'edge-api.json'), (error) => {
      assert.equal(error.code, 'BLUEPRINT_NO_SOURCE');
      assert.match(error.message, /architecture blueprint edge-api rule EA2 \("No function runs past its time limit\."\) names no source/u);
      return true;
    }, `a ${kind} rule without a source is refused`);
  }
  // A product, practice or beyond-code rule may still leave its source out.
  for (const kind of ['product', 'practice', 'beyond-code', undefined]) {
    assert.equal(validateBlueprint({ ...unsourced, kind }, 'edge-api.json').rules.length, 2, `a ${kind} blueprint needs no source`);
  }
  // A source that is not { name, id?, url? } with a web address is refused as a bad blueprint.
  for (const source of ['Example Framework', { id: 'OPS 8' }, { name: 'Example', url: 'ftp://example.com/x' }, { name: 'Example | Lens' }]) {
    const value = { ...SOURCED, rules: [{ ...SOURCED.rules[0], source }] };
    assert.throws(() => validateBlueprint(value, 'edge-api.json'), (error) => error.code === 'BAD_BLUEPRINT' && /rules\[0\]\.source/u.test(error.message), JSON.stringify(source));
  }

  // blueprint add refuses it with its next step and writes nothing.
  const box = freshBoard({ gate: 'true' });
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  writeFileSync(join(box.repo, 'unsourced.json'), `${JSON.stringify(unsourced)}\n`);
  const refused = box.run('blueprint', 'add', 'unsourced.json', '--json');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'BLUEPRINT_NO_SOURCE');
  assert.match(error.message, /architecture blueprint edge-api rule EA2/u);
  assert.match(error.next, /source \{ name, id, url \}/u);
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, 'a refused blueprint writes nothing');
  assert.equal(json(box, 'list', '--all').items.length, 0, 'and files no item');

  // init --blueprint refuses it before writing anything.
  const empty = emptyRepo();
  writeFileSync(join(box.dir, 'unsourced.json'), `${JSON.stringify(unsourced)}\n`);
  const init = empty.run('init', '--blueprint', join(box.dir, 'unsourced.json'), '--json');
  assert.notEqual(init.status, 0);
  assert.equal(JSON.parse(init.stdout).error.code, 'BLUEPRINT_NO_SOURCE');
  assert.deepEqual(readdirSync(empty.repo).filter((entry) => entry !== '.git'), [], 'init writes nothing');

  // Every bundled architecture blueprint names a source for every rule.
  for (const name of bundledBlueprints()) {
    const blueprint = readBlueprint(name, process.cwd());
    if (blueprint.kind !== 'architecture') continue;
    for (const rule of blueprint.rules) assert.ok(rule.source?.name && rule.source.url, `${name} ${rule.key} names its source`);
  }
});

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

/** The text of the one pending row in the repo's SPEC.md whose question starts with the ask. */
function pendingQuestion(repo, ask) {
  const rows = parseSpec(readFileSync(join(repo, 'SPEC.md'), 'utf8')).rows.filter((row) => row.status === 'pending' && row.text.startsWith(`${ask}: `));
  assert.equal(rows.length, 1, `one pending "${ask}" row`);
  return rows[0].text;
}

const RUNNERS = 'Choices: node:test, Vitest, Jest, Mocha, pytest, Something else.';
const FRAMEWORKS = 'Choices: Next.js, SvelteKit, Rails, Something else.';

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


