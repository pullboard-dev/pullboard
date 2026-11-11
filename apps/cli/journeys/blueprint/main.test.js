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
import { resolve } from 'node:path';

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
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../../packages/blueprints/data/blueprints/${name}.json`), 'utf8'));
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
