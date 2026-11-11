/** @pullboard-test-input packages/blueprints/data/blueprints/*.json */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { bundledBlueprints } from '../../../../packages/blueprints/index.js';
import { readBlueprint } from '../../../../packages/blueprints/index.js';
import { validateBlueprint } from '../../../../packages/blueprints/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { assertArchitectureBlueprintCoverage } from '../../tests/fixtures/blueprint/coverage.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { LEGACY_FRAMEWORK } from '../../tests/fixtures/blueprint.js';
import { DIRS } from '../../tests/fixtures/blueprint.js';
import { freshBoard } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';
import { SOURCED } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { bundled } from '../../tests/fixtures/blueprint.js';
import { ok } from '../../tests/fixtures/blueprint.js';
import { refusal } from '../../tests/fixtures/blueprint.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { blueprintRowIds } from '../../../../packages/blueprints/index.js';
import { starterStates } from '../../../../packages/blueprints/index.js';
import { boardCreated } from '../../tests/fixtures/blueprint.js';
import { TELEMETRY } from '../../tests/fixtures/blueprint.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { RUNNERS } from '../../tests/fixtures/blueprint.js';
import { FRAMEWORKS } from '../../tests/fixtures/blueprint.js';
import { draftedTexts } from '../../tests/fixtures/blueprint.js';
import { hostname } from 'node:os';
import { assertStarterChecks } from '../../tests/fixtures/blueprint/starter.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { e2e } from '../../tests/fixtures/blueprint.js';
import { fitDigest } from '../../tests/fixtures/blueprint.js';
import { batchCode } from '../../tests/fixtures/blueprint.js';
import { fitBoard } from '../../tests/fixtures/blueprint.js';

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

test('bundled starters file with their criterion and check, stored and never run [S1,I1]', () => {
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

test('infrastructure loads as architecture [S1]', async () => {
  const { BLUEPRINT_KINDS } = await import('../../../../packages/blueprints/index.js');
  // The kind is architecture now; the old name is no kind a blueprint is filed under.
  assert.ok(BLUEPRINT_KINDS.includes('architecture'));
  assert.equal(BLUEPRINT_KINDS.includes('infrastructure'), false);
  assert.equal(validateBlueprint({ ...SOURCED, kind: 'infrastructure' }, 'edge-api.json').kind, 'architecture');
  assert.equal(validateBlueprint({ ...SOURCED, kind: 'architecture' }, 'edge-api.json').kind, 'architecture');
  assert.throws(() => validateBlueprint({ ...SOURCED, kind: 'cloud' }, 'edge-api.json'), (error) => error.code === 'BAD_BLUEPRINT' && /kind must be one of product, architecture, practice, beyond-code/u.test(error.message));

  // A file that says infrastructure reads, and adds, as architecture.
  const box = freshBoard({ gate: 'true' });
  writeFileSync(join(box.repo, 'old.json'), `${JSON.stringify({ ...SOURCED, name: 'old-edge', kind: 'infrastructure' })}\n`);
  assert.equal(readBlueprint('old.json', box.repo).kind, 'architecture');
  assert.equal(json(box, 'blueprint', 'add', 'old.json').rows.length, 3);

  // The bundled files that said infrastructure now say architecture, and none says the old name.
  for (const name of bundledBlueprints()) {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, `../packages/blueprints/src/shell/blueprints/${name}.json`), 'utf8'));
    assert.notEqual(raw.kind, 'infrastructure', `${name} uses the new name`);
  }
  assert.deepEqual(['serverless', 'data-pipeline'].map((name) => readBlueprint(name, process.cwd()).kind), ['architecture', 'architecture']);
});

test('blueprint add files a blueprint as drafts with light and mid starters add accepts [S1,I1]', () => {
  // A light or mid starter carrying its brief, criterion and check is filed with all three passed to
  // the item unchanged; a light starter is filed mid, the route add gives it once light needs a
  // diagnosis, which only follows the add; a strong starter needs no brief.
  const box = freshBoard({ gate: 'true' });
  const brief = 'Files:\n- web/index.html\nTest:\n- test/home.test.js asserts the page fits 375 pixels';
  const items = [
    { key: '1', title: 'Light starter', cites: ['W3'], route: 'light', brief, criterion: 'The home page fits 375 pixels.', check: 'true' },
    { key: '2', title: 'Mid starter', cites: ['W1'], route: 'mid', brief, criterion: 'A test fails without the change.', check: 'true', after: ['1'] },
    { key: '3', title: 'Strong starter', cites: ['W2'], criterion: 'The suite passes on main.', check: 'true' },
  ];
  writeFileSync(join(box.repo, 'routes.json'), `${JSON.stringify({ ...PUBLISHED, name: 'routes', items })}\n`);
  const added = json(box, 'blueprint', 'add', 'routes.json');
  assert.equal(added.items.length, 3);
  const filed = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.deepEqual(filed.map((item) => [item.item_title, item.item_route, item.item_check, item.item_criterion, item.item_brief]), [
    ['Light starter', 'mid', 'true', items[0].criterion, brief],
    ['Mid starter', 'mid', 'true', items[1].criterion, brief],
    ['Strong starter', 'strong', 'true', items[2].criterion, ''],
  ]);
  assert.equal(filed[1].item_after, String(filed[0].item_id));
});

test('blueprint add files a blueprint as drafts beside approved rows in its own section [S1,I1]', () => {
  // The person already wrote the blueprint's section, with one rule approved in the same words: a
  // first add still files every rule as a draft and every question as a pending row.
  const box = freshBoard();
  const file = join(box.repo, 'SPEC.md');
  const rule = `${PUBLISHED.rules[0].text} Why: ${PUBLISHED.rules[0].why}`;
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n## A · Web app\n\n- A1 [approved, must] ${rule} | gate: review\n- A2 [approved, must] ${LEGACY_FRAMEWORK.ask}: Rails. Choices: Rails, Next.js. | gate: review\n`);
  box.git('commit', '-q', '-am', 'chore: approve rows in the blueprint section');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(added.section, 'A · Web app', 'the rows go in the existing section');
  assert.deepEqual(added.rows.map((row) => [row.key, row.status]), [
    ...PUBLISHED.rules.map((entry) => [entry.key, 'draft']), ...PUBLISHED.questions.map((entry) => [entry.key, 'pending']), ...PUBLISHED.defaults.map((entry) => [entry.key, 'fact'])]);
  const spec = parseSpec(readFileSync(file, 'utf8'));
  assert.deepEqual(spec.rows.filter((row) => row.status === 'approved').map((row) => row.id), ['A1', 'A2']);
  assert.equal(spec.rows.filter((row) => row.section === 'A · Web app').length, 13);
});

test('blueprint commands say what they did [S1,I1]', () => {
  // Every file's bytes outside Git's object store (seat timing and the command trace are per-command telemetry, not board state), and every board event, so a repeat add is proven to change nothing.
  const snapshot = (box) => {
    const files = readdirSync(box.repo, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.includes(`${join('.git', 'objects')}`) && !/board\.sqlite/u.test(path) && !TELEMETRY.test(path))
      .sort()
      .map((path) => [path, readFileSync(path).toString('base64')]);
    return { files, events: json(box, 'log').events };
  };

  // Before any add, every starter is listed and none is filed, even with an older unrelated item
  // filed under a starter's title that cites no blueprint row (review 12394).
  const box = freshBoard();
  const decoy = json(box, 'add', 'coordinator', PUBLISHED.items[0].title).item;
  assert.equal(decoy.item_spec_ids ?? '', '', 'the unrelated item cites no row');
  // A row that exists before the add, and an older item under another starter's title citing it.
  const existingRow = json(box, 'spec', 'draft', 'A requirement written before the blueprint').id;
  const citing = json(box, 'add', 'coordinator', PUBLISHED.items[1].title, '--specs', existingRow).item;
  assert.equal(citing.item_spec_ids, existingRow, 'the second unrelated item cites the row that was there first');
  const unfiled = json(box, 'blueprint', 'starters', 'web-app');
  assert.deepEqual(unfiled.blueprint, { name: 'web-app', title: 'Web app', version: 1 });
  assert.deepEqual(unfiled.starters.map((starter) => [starter.title, starter.filed, starter.id]), PUBLISHED.items.map((item) => [item.title, false, null]));
  const unfiledText = box.run('blueprint', 'starters', 'web-app');
  assert.equal(unfiledText.status, 0, unfiledText.stdout + unfiledText.stderr);
  for (const item of PUBLISHED.items) assert.ok(unfiledText.stdout.split('\n').includes(`  not filed  ${item.title}`), `${item.title} is listed as not filed:\n${unfiledText.stdout}`);

  // A second add says it is already there, and no file byte and no board event changes.
  const firstAdd = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(firstAdd.items.length, PUBLISHED.items.length, 'the add files every starter');
  const before = snapshot(box);
  const again = box.run('blueprint', 'add', 'web-app');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^Web app \(version 1\) is already on this board; nothing added/mu, 'a second add says so');
  assert.match(again.stdout, /pullboard blueprint starters web-app/u, 'a second add points at its starters');
  const repeat = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual([repeat.marked, repeat.rows, repeat.items, repeat.gate], [true, [], [], null]);
  const after = snapshot(box);
  assert.deepEqual(after.files, before.files, 'a second add changes no file bytes');
  assert.deepEqual(after.events, before.events, 'a second add records no board event');

  // Once added, each starter names the item its add filed, never the unrelated same-title item.
  const filed = json(box, 'blueprint', 'starters', 'web-app').starters;
  assert.equal(filed.length, PUBLISHED.items.length, 'every starter is listed');
  const filedText = box.run('blueprint', 'starters', 'web-app').stdout.split('\n');
  for (const [index, item] of PUBLISHED.items.entries()) {
    const own = firstAdd.items.find((entry) => entry.key === item.key);
    assert.ok(own && own.id !== decoy.item_id, `${item.title} was filed by the add as its own item`);
    assert.notEqual(filed[index].id, decoy.item_id, `${item.title} never names the unrelated item #${decoy.item_id}`);
    assert.deepEqual([filed[index].title, filed[index].filed, filed[index].id, filed[index].status], [item.title, true, own.id, 'open']);
    assert.ok(filedText.includes(`  #${own.id} open  ${item.title}`), `${item.title} shows its id:\n${filedText.join('\n')}`);
  }
  assert.ok(!filedText.some((line) => line.startsWith(`  #${decoy.item_id} `)), `the unrelated item is never listed:\n${filedText.join('\n')}`);
  assert.ok(!filed.some((starter) => starter.id === citing.item_id), 'an item citing a row from before the add is never the starter');

  // Two versions of one blueprint, the same title and starter: each version names the item it filed.
  const versioned = join(box.dir, 'versioned.json');
  // No kind: web-app already holds its kind on this board, and a blueprint of a kind already taken is refused (#720).
  const firstVersion = { ...PUBLISHED, name: 'versioned', title: 'Versioned plan', version: 1, kind: undefined, items: [PUBLISHED.items[0]] };
  writeFileSync(versioned, JSON.stringify(firstVersion));
  const one = json(box, 'blueprint', 'add', versioned).items[0];
  writeFileSync(versioned, JSON.stringify({ ...firstVersion, version: 2 }));
  const two = json(box, 'blueprint', 'add', versioned).items[0];
  assert.notEqual(two.id, one.id, 'version 2 files its own starter');
  const forTwo = json(box, 'blueprint', 'starters', versioned);
  assert.deepEqual([forTwo.blueprint.version, forTwo.starters[0].id], [2, two.id], 'version 2 names the item version 2 filed');
  writeFileSync(versioned, JSON.stringify(firstVersion));
  assert.equal(json(box, 'blueprint', 'starters', versioned).starters[0].id, one.id, 'version 1 names the item version 1 filed');

  // Verbose init --blueprint lists every row that waits for the person, the inherited doctrine row PB7 included.
  const started = emptyRepo();
  const init = started.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const waiting = JSON.parse(started.run('spec', '--json').stdout).rows.filter((row) => ['draft', 'pending'].includes(row.status));
  const doctrineRows = waiting.filter((row) => row.file !== 'SPEC.md');
  const specRows = waiting.filter((row) => row.file === 'SPEC.md');
  assert.ok(doctrineRows.some((row) => row.id === 'PB7' && row.status === 'pending'), 'the standard doctrine has PB7 pending');
  assert.equal(specRows.length, PUBLISHED.rules.length + PUBLISHED.questions.length);
  const lines = init.stdout.split('\n');
  for (const row of doctrineRows) assert.ok(lines.includes(`    ${row.id} ${row.status}  ${row.text}  (${row.file})`), `init names doctrine row ${row.id}:\n${init.stdout}`);
  for (const row of specRows) assert.ok(lines.includes(`    ${row.id} ${row.status}  ${row.text}  (SPEC.md)`), `init names spec row ${row.id}:\n${init.stdout}`);
  assert.ok(lines.includes(`  ${waiting.length} rows wait for the person:`), `init counts every waiting row:\n${init.stdout}`);
  const fromJson = emptyRepo().run('init', '--blueprint', 'web-app', '--json');
  assert.equal(fromJson.status, 0, fromJson.stdout + fromJson.stderr);
  assert.deepEqual(JSON.parse(fromJson.stdout).blueprint.waitingRows.map((row) => row.id).sort(), waiting.map((row) => row.id).sort(), 'the JSON lists the same waiting rows');

  // A second init --blueprint says the blueprint is already there.
  const reinit = started.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(reinit.status, 0, reinit.stdout + reinit.stderr);
  assert.match(reinit.stdout, /the Web app blueprint \(version 1\) is already on this board; nothing added/u);
  assert.doesNotMatch(reinit.stdout, /added the Web app blueprint/u);
});

test('blueprint starters reads its own version on a board added before starter links [S1,I1]', () => {
  // An older Pullboard filed starters with no link note (review of #734, the v1/v2 upgrade counter): two versions of one
  // custom blueprint, one title and one starter. Read back with no links, each version must still find the item it filed.
  const box = freshBoard();
  const file = join(box.dir, 'versioned.json');
  const first = { ...PUBLISHED, name: 'versioned', title: 'Versioned plan', version: 1, items: [PUBLISHED.items[0]] };
  writeFileSync(file, JSON.stringify(first));
  const one = json(box, 'blueprint', 'add', file).items[0];
  writeFileSync(file, JSON.stringify({ ...first, version: 2 }));
  const two = json(box, 'blueprint', 'add', file).items[0];
  assert.notEqual(two.id, one.id, 'version 2 files its own starter');
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const spec = parseSpec(source);
  const items = json(box, 'list', '--all').items;
  const unlinked = new Map();
  for (const [version, id] of [[1, one.id], [2, two.id]]) {
    const blueprint = { ...first, version };
    const [found] = starterStates(blueprint, items, blueprintRowIds(blueprint, spec, source), unlinked);
    assert.deepEqual([found.filed, found.id], [true, id], `version ${version} names the item version ${version} filed, never the other version's`);
  }
});

test('blueprint add files a blueprint as drafts after an add stopped part way [S1,I1]', () => {
  // A finished add on one board gives the exact rows; a second board is left where an add stops
  // after its rows and first starter: the rows and the under-way marker written, item 1 added.
  const reference = freshBoard();
  const done = json(reference, 'blueprint', 'add', 'web-app');
  const ids = Object.fromEntries(done.rows.map((row) => [row.key, row.id]));
  const underWay = `<!-- pullboard-blueprint web-app 1 adding ${Object.entries(ids).map(([key, id]) => `${key}=${id}`).join(' ')} -->`;
  const finished = readFileSync(join(reference.repo, 'SPEC.md'), 'utf8');
  assert.ok(finished.includes('<!-- pullboard-blueprint web-app 1 -->'));
  const box = freshBoard();
  writeFileSync(join(box.repo, 'SPEC.md'), finished.replace('<!-- pullboard-blueprint web-app 1 -->', underWay));
  box.git('commit', '-q', '-am', 'chore: leave an add part way');
  const first = json(box, 'add', 'coordinator', PUBLISHED.items[0].title, '--specs', `${ids.W1},${ids.W2}`);
  const retried = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(retried.rows, [], 'no row is filed twice');
  assert.deepEqual(retried.items.map((item) => item.key), ['2', '3'], 'only the missing starters are added');
  assert.deepEqual(retried.items.find((item) => item.key === '3').after, [first.item.item_id], 'the third starter still waits on the first');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), finished, 'the finished marker replaces the under-way one');
  assert.equal(json(box, 'blueprint', 'add', 'web-app').items.length, 0, 'and then a repeat adds nothing');
});

test('clause 1: init --blueprint starts a board from a blueprint [I1,S1]', () => {
  const waiting = PUBLISHED.rules.length + PUBLISHED.questions.length;

  // A known and a local blueprint are added together: init sets up the board once, and stores
  // starter checks without running them.
  const known = emptyRepo();
  const checked = join(known.repo, 'checked.json');
  writeFileSync(checked, JSON.stringify({ blueprint: 1, name: 'checked', title: 'Checked plan', version: 1,
    kind: 'practice', prefix: 'K', rules: [{ key: 'K1', text: 'Checks are stored as written.', why: 'The receiving project decides when to run them.' }],
    defaults: [], questions: [], items: [{ key: '1', title: 'Checked starter', cites: ['K1'], after: [], lane: 'core', route: 'light',
      criterion: 'The checked starter is filed.', brief: 'Files:\n- web/checked.js\nTest:\n- test/checked.test.js checks the starter', check: 'true' }] }));
  const started = known.run('init', '--blueprint', 'web-app', '--blueprint', 'checked.json', '--verbose');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const summary = started.stdout.split('\n').filter((line) => line.startsWith(`added the ${PUBLISHED.title} blueprint:`));
  assert.equal(summary.length, 1, started.stdout);
  assert.match(summary[0], new RegExp(`: ${waiting} rows wait for your approval in SPEC\\.md \\(.*${PUBLISHED.title}\\), ${PUBLISHED.items.length} starter items filed`, 'u'));
  const spec = parseSpec(readFileSync(join(known.repo, 'SPEC.md'), 'utf8'));
  const section = spec.sections.find((entry) => entry.name.includes(PUBLISHED.title));
  assert.ok(section, 'the blueprint has its own SPEC.md section');
  const rows = spec.rows.filter((row) => row.section === section.name);
  assert.equal(rows.length, waiting + PUBLISHED.defaults.length);
  assert.ok(rows.every((row) => row.status !== 'approved'), 'nothing is approved');
  const items = JSON.parse(known.run('list', '--json').stdout).items ?? [];
  assert.equal(items.length, PUBLISHED.items.length + 1, 'each starter item is filed once');
  const checkedItem = items.find((item) => item.item_title === 'Checked starter');
  assert.ok(checkedItem, 'the checked starter is filed with the other blueprint items');
  assert.equal(checkedItem.item_check, 'true', 'its check is stored as written');
  assert.equal(checkedItem.item_check_baseline ?? null, null, 'no check baseline was started');
  assert.match(started.stdout, /checks stored, not run: #\d+(?:, #\d+)*; no check baseline ran/u,
    'the summary says starter checks were stored, not run');
  assert.ok(existsSync(join(known.repo, 'pullboard.json')) && existsSync(join(known.repo, 'DOCTRINE.md')), 'init set the repository up as usual');

  // Unknown names and URLs are refused before anything is written, naming the bundled blueprints.
  const unknown = emptyRepo();
  const refused = unknown.run('init', '--blueprint', 'no-such-blueprint', '--json');
  assert.notEqual(refused.status, 0);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'NO_BLUEPRINT');
  assert.match(refusal.message, /web-app/u, 'the refusal lists the bundled blueprints');
  assert.deepEqual(readdirSync(unknown.repo).filter((name) => name !== '.git'), [], 'nothing is written');
  assert.equal(boardCreated(unknown.repo), false, 'no board is created');
  const fetched = unknown.run('init', '--blueprint', 'https://example.invalid/web-app.json', '--json');
  assert.notEqual(fetched.status, 0);
  assert.equal(JSON.parse(fetched.stdout).error.code, 'BLUEPRINT_URL');
  assert.deepEqual(readdirSync(unknown.repo).filter((name) => name !== '.git'), [], 'a URL writes nothing');
  assert.equal(boardCreated(unknown.repo), false, 'a URL creates no board');

  // Run from a subdirectory, a relative path names a file there: init reads it once, before
  // writing anything, and adds that very blueprint.
  const nested = emptyRepo();
  mkdirSync(join(nested.repo, 'plans'));
  writeFileSync(join(nested.repo, 'plans', 'local.json'), JSON.stringify({ ...PUBLISHED, name: 'local', title: 'Local plan' }));
  const fromSub = nested.runIn(join(nested.repo, 'plans'), 'init', '--blueprint', 'local.json', '--verbose');
  assert.equal(fromSub.status, 0, fromSub.stdout + fromSub.stderr);
  assert.match(fromSub.stdout, /added the Local plan blueprint:/u, 'the file next to the caller is the one added');
  assert.equal((JSON.parse(nested.run('list', '--json').stdout).items ?? []).length, PUBLISHED.items.length);

  // Plain init is unchanged: no blueprint section, no items, no summary line.
  const plain = emptyRepo();
  const initialized = plain.run('init');
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  assert.doesNotMatch(initialized.stdout, /^added the .+ blueprint:/mu, 'plain init prints no blueprint summary');
  assert.doesNotMatch(readFileSync(join(plain.repo, 'SPEC.md'), 'utf8'), /pullboard-blueprint/u);
  assert.deepEqual(JSON.parse(plain.run('list', '--json').stdout).items ?? [], []);
});

/** The text of the one pending row in the repo's SPEC.md whose question starts with the ask. */
function pendingQuestion(repo, ask) {
  const rows = parseSpec(readFileSync(join(repo, 'SPEC.md'), 'utf8')).rows.filter((row) => row.status === 'pending' && row.text.startsWith(`${ask}: `));
  assert.equal(rows.length, 1, `one pending "${ask}" row`);
  return rows[0].text;
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
    assert.equal(boardCreated(box.repo), false, 'no board is created');
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

test('a saved board adds back as the same rows [S1]', () => {
  const box = e2e.project();
  const machine = hostname().split('.')[0];
  box.git(box.repo, 'config', 'user.name', 'Dana Whitlock');
  box.git(box.repo, 'config', 'user.email', 'dana.whitlock@example.org');
  const kept = [
    '- K1 [approved, must] Every change ships with a test that fails without it. Why: a test that passes either way proves nothing. | gate: web/page.test.js | signers: DW',
    '- K2 [approved, aim] Every page works at phone width. Why: a page that only works on a laptop is a bug nobody reports. | gate: review',
    '- K3 [approved, must] The app is built with: SvelteKit. Choices: Next.js, SvelteKit, Rails. | gate: review',
    '- K12 [approved, must] Deploy: where it goes: Fly.io. Choices: Vercel, Fly.io. | gate: review',
    '- K13 [approved, must] People sign in with: Email, then a link. Choices: Email, then a link, Passwords. | gate: review',
    '- K14 [approved, must] Pick one: x. Choices: x, y, z, w. | gate: review',
  ];
  const planted = [
    '- K4 [approved, must] Logs live in web/logs/app.js. Why: one place to look. | gate: review',
    '- K5 [approved, must] Escalations go to dana.whitlock@example.org first. Why: she owns releases. | gate: review',
    '- K6 [approved, must] Agent web-1 owns the header. Why: it wrote it. | gate: review',
    '- K7 [approved, must] Dana approves every release. Why: she carries the pager. | gate: review',
    `- K8 [approved, must] Builds run on ${machine} only. Why: it holds the signing key. | gate: review`,
    '- K9 [approved, must] The page renders without a reason. | gate: review',
    '- K10 [draft, must] A draft never leaves. Why: nobody decided it. | gate: review',
    '- K11 [pending, must] Deploys go to: Vercel. Choices: Vercel, Fly.io. | gate: review',
    '- K15 [approved, must] Pick a host: Rails. Choices: Vercel, Fly.io. | gate: review',
    '- K16 [approved, must] A rule. Why: one. Why: two. | gate: review',
  ];
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, name: 'Dana Whitlock board' }, null, 2));
  writeFileSync(join(box.repo, 'SPEC.md'), `${readFileSync(join(box.repo, 'SPEC.md'), 'utf8')}\n## K · Kept\n\n<!-- pullboard-blueprint kept 1 -->\n<!-- pullboard-blueprint kept 2 adding K1=K1 K3=K3 -->\n${[...kept, ...planted].join('\n')}\n`);
  box.git(box.repo, 'add', 'SPEC.md', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: plant private rows');
  const item = fixtureAdd(box.run, box.repo, 'web', 'Private item title zebra', '--specs', 'G1', '--criterion', 'secret criterion walrus');
  assert.equal(item.code, 0, item.err);
  assert.equal(box.run(box.web, 'shout', 'all', 'private shout narwhal').code, 0);

  const saved = box.run(box.repo, 'blueprint', 'save', '--json');
  assert.equal(saved.code, 0, `${saved.err}\n${saved.out}`);
  assert.deepEqual(JSON.parse(saved.out).left.map((entry) => entry.id).sort(), ['G1', 'G2', 'K15', 'K16', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'], 'only clean, exactly readable approved rows leave');
  const file = join(box.repo, 'Dana Whitlock board.blueprint.json');
  const text = readFileSync(file, 'utf8');
  for (const secret of ['web/', '@', 'Dana', 'Whitlock', 'web-1', machine, 'zebra', 'walrus', 'narwhal', 'signers', 'DW', 'items', 'pullboard-blueprint', 'Logs live', 'draft never', 'Deploys go']) {
    assert.ok(!text.includes(secret), `the blueprint never carries ${JSON.stringify(secret)}`);
  }
  const blueprint = JSON.parse(text);
  assert.deepEqual([blueprint.name, blueprint.title], ['my-blueprint', 'My blueprint'], 'the project name never goes in; a neutral default does');
  const named = box.run(box.repo, 'blueprint', 'save', 'named.json', '--name', 'dana-whitlock', '--json');
  assert.equal(JSON.parse(named.out).error?.code, 'PRIVATE_BLUEPRINT', 'a chosen name that names someone is refused');
  assert.deepEqual(Object.keys(blueprint).sort(), ['blueprint', 'gate', 'name', 'questions', 'rules', 'title', 'version'], 'only allow-listed fields are written');
  assert.deepEqual(blueprint.rules.map((rule) => Object.keys(rule).sort()), [['gate', 'key', 'text', 'tier', 'why'], ['gate', 'key', 'text', 'tier', 'why']]);
  assert.deepEqual(blueprint.questions.map((question) => Object.keys(question).sort()), Array(4).fill(['ask', 'choices', 'default', 'key']));
  assert.equal(box.run(box.repo, 'blueprint', 'save', '--json').code, 1, 'an existing file is never overwritten');

  const fresh = e2e.project();
  const before = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.map((row) => row.id);
  const added = fresh.run(fresh.repo, 'blueprint', 'add', file);
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const rows = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.filter((row) => !before.includes(row.id));
  assert.deepEqual(rows.map((row) => [row.status, row.tier, row.text]), [
    ['draft', 'must', 'Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.'],
    ['draft', 'aim', 'Every page works at phone width. Why: a page that only works on a laptop is a bug nobody reports.'],
    ['pending', 'must', 'The app is built with: SvelteKit. Choices: Next.js, SvelteKit, Rails.'],
    ['pending', 'must', 'Deploy: where it goes: Fly.io. Choices: Vercel, Fly.io.'],
    ['pending', 'must', 'People sign in with: Email, then a link. Choices: Email, then a link, Passwords.'],
    ['pending', 'must', 'Pick one: x. Choices: x, y, z, w.'],
  ], 'the approved rows come back as drafts, each answered question exactly, its answer the default');
  assert.deepEqual(JSON.parse(fresh.run(fresh.repo, 'list', '--json').out).items ?? [], [], 'a saved blueprint files no items');
});

test('blueprint save reads back a question with three or more choices [S1]', () => {
  const box = freshBoard();
  const questions = [
    'The app is built with: Next.js. Choices: Next.js, SvelteKit, Rails.',
    'People sign in with: Magic links. Choices: Passwords, Passkeys, Single sign-on, Magic links.',
    'Deploy: where it goes: Fly.io, then Vercel. Choices: Render, Fly.io, then Vercel, Railway.',
  ];
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n## Q · Questions\n\n${questions.map((text, index) => `- Q${index + 1} [approved, must] ${text} | gate: review`).join('\n')}\n`);
  box.git('add', 'SPEC.md');
  box.git('commit', '-q', '-m', 'chore: answer three questions');

  const saved = json(box, 'blueprint', 'save', 'questions.json', '--name', 'stack-questions', '--title', 'Stack questions');
  assert.deepEqual(saved.left.filter((entry) => entry.id.startsWith('Q')), [], 'no answered question is left out');
  const blueprint = JSON.parse(readFileSync(join(box.repo, 'questions.json'), 'utf8'));
  assert.deepEqual(blueprint.questions.map(({ key, ask, choices, default: answer }) => [key, ask, choices, answer]), [
    ['Q1', 'The app is built with', ['Next.js', 'SvelteKit', 'Rails'], 'Next.js'],
    ['Q2', 'People sign in with', ['Passwords', 'Passkeys', 'Single sign-on', 'Magic links'], 'Magic links'],
    ['Q3', 'Deploy: where it goes', ['Render', 'Fly.io, then Vercel', 'Railway'], 'Fly.io, then Vercel'],
  ], 'a three-choice and a four-choice question keep their listed choices and the chosen answer');

  const fresh = freshBoard();
  const before = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.map((row) => row.id);
  json(fresh, 'blueprint', 'add', join(box.repo, 'questions.json'));
  const rows = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.filter((row) => !before.includes(row.id));
  assert.deepEqual(rows.map((row) => [row.status, row.text]), questions.map((text) => ['pending', text]),
    'each question round-trips to its exact row text');
});

test('a fit proposal waits for the person and keeps its reason [S1,E3]', () => {
  const { box, seat, key, starter } = fitBoard();
  assert.match(box.run('help', 'blueprint').stdout, /^Usage: pullboard blueprint add <name or file>, then a seat runs pullboard blueprint fit .+, then the person runs pullboard spec fit approve <batch>$/mu, 'help blueprint names the fit step');
  const W1 = key('W1');
  const W2 = key('W2');
  const W3 = key('W3');
  const Q1 = key('Q1');
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const criterionBefore = ok(box.run('show', String(starter('1')), '--json'), 'show').item_criterion;
  const adapted = 'Every change ships with a node:test test that fails without it. Why: one runner keeps the gate honest.';
  const proposals = [
    [W1, 'adapt', '--text', adapted, '--reason', 'this repo already tests with node --test'],
    [W2, 'keep'],
    [W3, 'drop', '--reason', 'this repo is a library with no pages'],
    [Q1, 'answer', '--text', 'Something else', '--reason', 'a plain node:test library with no web framework'],
    [`#${starter('1')}`, 'adapt', '--text', 'npm test runs node --test with one passing test', '--reason', 'the runner is already node:test'],
    [`#${starter('2')}`, 'drop', '--reason', 'there is no home page to fit to a phone'],
  ];
  const by = new Set();
  for (const args of proposals) {
    const recorded = ok(seat('blueprint', 'fit', 'legacy-web-app.json', ...args, '--json'), `fit ${args.join(' ')}`).proposals[0];
    by.add(recorded.by);
  }
  assert.equal(by.size, 1, 'one seat recorded every proposal');
  const seatId = [...by][0];
  assert.match(seatId, /^web-/u, "the proposer is the seat's own id");
  assert.equal(refusal(seat('blueprint', 'fit', 'legacy-web-app.json', W2, 'keep', '--by', 'person', '--json'), 'a flag naming the proposer'), 'FLAG_NOT_ALLOWED');
  assert.equal(refusal(seat('blueprint', 'fit', 'legacy-web-app.json', W3, 'drop', '--json'), 'a drop with no reason'), 'FIT_PROPOSAL');

  // Nothing applies before the person approves: SPEC.md, the row decisions and the starters are as they were.
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specBefore, 'SPEC.md is unchanged');
  for (const id of [W1, W2, W3, Q1]) assert.equal(ok(box.run('spec', 'show', id, '--json'), 'spec show').row.decision, undefined, `${id} has no decision yet`);
  const first = ok(box.run('show', String(starter('1')), '--json'), 'show');
  assert.equal(first.item_criterion, criterionBefore, 'the starter keeps its criterion');
  assert.equal(ok(box.run('show', String(starter('2')), '--json'), 'show').item_status, 'open', 'the dropped starter is still open');

  // The person sees every proposal together: in pullboard spec, and in the view's state.
  const listed = box.run('spec');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /blueprint fit: 6 unverified draft proposals wait for the person; nothing applies until the person approves the batch/u);
  assert.doesNotMatch(listed.stdout, /proposed by/u, 'a recorder is never shown as an authenticated author');
  for (const [target, decision] of proposals) assert.match(listed.stdout, new RegExp(`^  ${target} ${decision} \\(unverified draft, recorded as ${seatId}\\)`, 'mu'), `${target} is listed`);
  assert.match(listed.stdout, new RegExp(`${W3} drop \\(unverified draft, recorded as ${seatId}\\); reason: this repo is a library with no pages; blueprint source: web-app v1 rule W3: Every page works at phone width`, 'u'));
  assert.equal(ok(box.run('spec', 'fit', '--json'), 'spec fit').proposals.length, 6);
  const out = join(box.dir, 'export');
  assert.equal(box.run('view', '--export', out).status, 0);
  const boards = JSON.parse(readFileSync(join(out, 'api/v1/boards.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(out, 'api/v1/boards', boards.boards[0].id, 'state.json'), 'utf8')).state;
  assert.ok(Array.isArray(state.fit), 'the view state carries the fit batch');
  assert.deepEqual(state.fit.map((proposal) => proposal.target), proposals.map(([target]) => target), 'the view state lists the whole batch');
  assert.ok(state.fit.every((proposal) => proposal.verified === false && proposal.recordedAs === seatId && !('by' in proposal) && !('session' in proposal)), 'the view shows each proposal as an unverified draft, never with an authenticated author');
  assert.equal(state.spec.find((row) => row.id === W1).stage, 'fit draft, unverified: adapt, waits for the person', 'a row shows its draft waiting');
  assert.equal(state.items.find((item) => item.id === starter('2')).fit.reason, 'there is no home page to fit to a phone');
  const w1Fit = state.fit.find((proposal) => proposal.target === W1);
  assert.deepEqual([w1Fit.decision, w1Fit.text, w1Fit.reason, w1Fit.blueprint, w1Fit.key, w1Fit.source], ['adapt', adapted, 'this repo already tests with node --test', { name: 'web-app', version: 1 }, 'W1', 'Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.'], 'the view state carries each proposal with its text, reason and blueprint source');

  // The person edits one proposal and approves the batch.
  const reread = ok(box.run('spec', 'fit', 'edit', W2, 'drop', '--reason', 'the gate already holds main', '--json'), 'person edit');
  assert.equal(reread.proposals.length, 6, 'an edit shows the whole batch again');
  const done = ok(box.run('spec', 'fit', 'approve', reread.batch, '--json'), 'approve');
  assert.equal(done.proposals.length, 6);
  assert.ok(done.proposals.every((proposal) => proposal.state === 'approved' && proposal.approvedBy === 'person'));
  const w1 = ok(box.run('spec', 'show', W1, '--json'), 'spec show').row;
  assert.equal(w1.stage, 'approved, pending apply');
  assert.equal(w1.decision.text, adapted, 'the adaptation is the approved text');
  assert.equal(w1.decision.note, `blueprint fit adapt: this repo already tests with node --test; recorded as ${seatId}, unverified; blueprint source: web-app v1 rule W1: Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.`);
  const w3 = ok(box.run('spec', 'show', W3, '--json'), 'spec show').row;
  assert.equal(w3.stage, 'declined, pending apply');
  assert.equal(w3.reason, 'this repo is a library with no pages', 'the drop keeps its reason');
  assert.match(w3.decision.note, /blueprint source: web-app v1 rule W3: Every page works at phone width before it ships\./u, 'the drop keeps its blueprint source');
  assert.match(ok(box.run('spec', 'show', W2, '--json'), 'spec show').row.decision.note, /^blueprint fit drop: the gate already holds main; recorded as person, unverified;/u, "the person's edit is what applies");
  assert.equal(ok(box.run('spec', 'show', Q1, '--json'), 'spec show').row.decision.text, 'The app is built with: Something else. Choices: Next.js, SvelteKit, Rails, Something else.');
  const adaptedItem = ok(box.run('show', String(starter('1')), '--json'), 'show');
  assert.equal(adaptedItem.item_criterion, 'npm test runs node --test with one passing test');
  const dropped = ok(box.run('show', String(starter('2')), '--json'), 'show');
  assert.equal(dropped.item_status, 'withdrawn');
  assert.equal(dropped.item_withdrawn_reason, 'blueprint fit drop: there is no home page to fit to a phone');
  const thread = box.run('show', String(starter('2')));
  assert.match(thread.stdout, /blueprint fit drop: there is no home page to fit to a phone; recorded as web-\S+, unverified; blueprint source: web-app v1 starter 2: The home page works at phone width/u, 'the starter drop keeps its reason and source');

  // The coordinator applies the decisions to SPEC.md as usual.
  const applyResult = box.run('spec', 'apply');
  assert.equal(applyResult.status, 0, applyResult.stdout + applyResult.stderr);
  const applied = parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows;
  assert.deepEqual([W1, W3].map((id) => applied.find((row) => row.id === id)).map((row) => [row.status, row.text]), [['approved', adapted], ['wont', `${PUBLISHED.rules[2].text} Why: ${PUBLISHED.rules[2].why}`]]);
});

test('an agent cannot approve its own fit proposal [S1,E3,B26]', () => {
  const { box, worktree, seat, as, key } = fitBoard();
  const W3 = key('W3');
  ok(seat('blueprint', 'fit', 'legacy-web-app.json', W3, 'drop', '--reason', 'no pages here', '--json'), 'propose');
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  // The proposing session is refused by name, from its worktree or the main checkout, for approve and edit.
  assert.equal(refusal(seat('spec', 'fit', 'approve', 'any-code', '--json'), 'approve from the seat'), 'FIT_OWN_PROPOSAL');
  assert.equal(refusal(as('fit-seat', box.repo, 'spec', 'fit', 'approve', 'any-code', '--json'), 'approve from main'), 'FIT_OWN_PROPOSAL');
  assert.equal(refusal(as('fit-seat', box.repo, 'spec', 'fit', 'edit', W3, 'keep', '--json'), 'edit from main'), 'FIT_OWN_PROPOSAL');
  // Any other agent session is no person either, nor is the seat's worktree.
  assert.equal(refusal(as('another-seat', box.repo, 'spec', 'fit', 'approve', 'any-code', '--json'), 'another agent'), 'B26_PERSON_CHANNEL');
  assert.equal(refusal(as(null, worktree, 'spec', 'fit', 'approve', 'any-code', '--json'), 'a worktree terminal'), 'B26_PERSON_APPROVAL');
  // Nothing applied, and the proposal still waits for the person.
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specBefore);
  assert.equal(ok(box.run('spec', 'show', W3, '--json'), 'spec show').row.decision, undefined);
  const first = ok(box.run('spec', 'fit', '--json'), 'the person reads the batch');
  assert.equal(first.proposals.length, 1);

  // Every refusal below leaves the batch, the reading, SPEC.md and the board as they were.
  const file = join(box.repo, '.git', 'pullboard', 'blueprint-fit.json');
  const readingFile = join(box.repo, '.git', 'pullboard', 'blueprint-fit-viewed.json');
  const refusedWith = (code, batch, label) => {
    const before = [file, readingFile, join(box.repo, 'SPEC.md')].map((path) => readFileSync(path, 'utf8'));
    const result = box.run('spec', 'fit', 'approve', batch, '--json');
    assert.equal(refusal(result, label), code, label);
    assert.deepEqual([file, readingFile, join(box.repo, 'SPEC.md')].map((path) => readFileSync(path, 'utf8')), before, `${label}: nothing is persisted`);
    assert.equal(ok(box.run('spec', 'show', W3, '--json'), 'spec show').row.decision, undefined, `${label}: nothing applied`);
    return JSON.parse(result.stdout).error.message;
  };
  // A proposal changed in the file after the person read it is refused by name.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.proposals.at(-1).reason = 'a different reason slipped in after the reading';
  writeFileSync(file, `${JSON.stringify(stored)}\n`);
  assert.match(refusedWith('FIT_CHANGED', first.batch, 'approve after an edit'), new RegExp(`^${W3} \\(changed\\) differ from your last reading`, 'u'), 'the refusal names the changed proposal');
  // A proposal that arrives after the reading is refused too; an agent reading the batch does not count.
  const second = ok(box.run('spec', 'fit', '--json'), 'the person reads it again');
  assert.equal(second.proposals[0].reason, 'a different reason slipped in after the reading');
  const W4 = key('W4');
  ok(seat('blueprint', 'fit', 'legacy-web-app.json', W4, 'keep', '--json'), 'a later proposal');
  ok(seat('spec', 'fit', '--json'), 'the seat reads the batch');
  assert.match(refusedWith('FIT_CHANGED', second.batch, 'approve after a new proposal'), new RegExp(`^${W4} \\(new\\) differ from`, 'u'), 'the refusal names only the unread proposal');

  // The person reads both. A proposal deleted from the file after that reading is refused by name.
  const third = ok(box.run('spec', 'fit', '--json'), 'the person reads both');
  assert.equal(third.proposals.length, 2);
  const read = readFileSync(file, 'utf8');
  const readReading = readFileSync(readingFile, 'utf8');
  const both = JSON.parse(read);
  writeFileSync(file, `${JSON.stringify({ ...both, proposals: both.proposals.filter((proposal) => proposal.target !== W4) })}\n`);
  assert.match(refusedWith('FIT_CHANGED', third.batch, 'approve after a deletion'), new RegExp(`^${W4} \\(gone\\) differ from`, 'u'), 'the refusal names the deleted proposal');
  writeFileSync(file, read);
  // A reading rewritten to match a changed batch is caught: it no longer hashes to the code the person typed.
  const forged = JSON.parse(read);
  const target = forged.proposals.find((proposal) => proposal.target === W3);
  target.reason = 'slipped in with a matching reading';
  writeFileSync(file, `${JSON.stringify(forged)}\n`);
  const reading = JSON.parse(readReading);
  reading.reading.find((entry) => entry.id === target.id).digest = fitDigest(target);
  writeFileSync(readingFile, `${JSON.stringify(reading)}\n`);
  assert.notEqual(batchCode(reading.reading), third.batch, 'the forged reading has another code');
  assert.match(refusedWith('FIT_READING', third.batch, 'approve after the reading was rewritten'), new RegExp(`^${third.batch} is not the batch code of your last reading`, 'u'));
  // The forger's own code fails the same way once the reading is put back, since the batch differs.
  writeFileSync(readingFile, readReading);
  assert.match(refusedWith('FIT_CHANGED', third.batch, 'approve a forged batch'), new RegExp(`^${W3} \\(changed\\)`, 'u'));

  // An unread proposal given a read one's id, and placed first, is refused by name: ids are never merged.
  writeFileSync(file, read);
  const W5 = key('W5');
  ok(seat('blueprint', 'fit', 'legacy-web-app.json', W5, 'keep', '--json'), 'an unread proposal');
  const withW5 = JSON.parse(readFileSync(file, 'utf8'));
  const unread = withW5.proposals.find((proposal) => proposal.target === W5);
  unread.id = withW5.proposals.find((proposal) => proposal.target === W3).id;
  writeFileSync(file, `${JSON.stringify({ ...withW5, proposals: [unread, ...withW5.proposals.filter((proposal) => proposal !== unread)] })}\n`);
  assert.match(refusedWith('FIT_FILE', third.batch, 'approve with a shared id'), new RegExp(`^${W5}, ${W3} share a proposal id`, 'u'), 'the refusal names both targets');
  assert.equal(refusal(box.run('spec', 'fit', '--json'), 'read a batch with a shared id'), 'FIT_FILE');
  assert.equal(ok(box.run('spec', 'show', W5, '--json'), 'spec show').row.decision, undefined, 'the unread proposal applied nothing');

  // Put back as the person read it, the batch is the person's to approve, with the code they were shown.
  writeFileSync(file, read);
  assert.equal(refusal(box.run('spec', 'fit', 'approve', '--json'), 'approve with no batch code'), 'USAGE');
  const approved = ok(box.run('spec', 'fit', 'approve', third.batch, '--json'), 'the person approves');
  assert.deepEqual(approved.decisions.map((record) => [record.id, record.decision]), [[W3, 'decline'], [W4, 'approve']]);
});

test('a Something else answer that names the stack fits a plain Node project [A8]', () => {
  // A plain Node project is not one of A8's named frameworks, so Something else takes the stack's name (#916).
  const { seat, key } = fitBoard();
  const stack = 'Node.js with built-in node:http and node:test';
  const proposal = ok(seat('blueprint', 'fit', 'legacy-web-app.json', key('Q1'), 'answer', '--text', stack, '--reason', 'a plain Node project with no web framework', '--json'), 'answer the stack question').proposals[0];
  assert.equal(proposal.decision, 'answer');
  assert.equal(proposal.text, `The app is built with: ${stack}. Choices: Next.js, SvelteKit, Rails, Something else.`);
});

test("clause 1: every bundled blueprint's starter check runs from its lane's folder and a baseline never reads green for a command that fails on main [I1,V2]", () => assertStarterChecks({ emptyRepo, freshBoard, json }));
