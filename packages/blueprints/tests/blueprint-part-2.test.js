/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { bundledBlueprints } from '../index.js';
import { readBlueprint } from '../index.js';
import { validateBlueprint } from '../index.js';
import { blueprintRowIds } from '../index.js';
import { starterStates } from '../index.js';
import { parseSpec } from '../../spec/index.js';
import { PUBLISHED } from './blueprint-fixture.js';
import { LEGACY_FRAMEWORK } from './blueprint-fixture.js';
import { freshBoard } from './blueprint-fixture.js';
import { json } from './blueprint-fixture.js';
import { UNSAFE_CHECK } from './blueprint-fixture.js';
import { emptyRepo } from './blueprint-fixture.js';
import { bundled } from './blueprint-fixture.js';
import { refusal } from './blueprint-fixture.js';

test('infrastructure loads as architecture [S1]', async () => {
  const { BLUEPRINT_KINDS } = await import('../index.js');
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
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, `../src/shell/blueprints/${name}.json`), 'utf8'));
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

test('bundled blueprint rows carry their checks [S1,I1]', async () => {
  // Imported here so the file's import lines stay as they are for the items editing them now.
  const { questionText, ruleText, saveBlueprint } = await import('../index.js');
  const rule = (blueprint, key) => blueprint.rules.find((entry) => entry.key === key);
  const library = readBlueprint('library', process.cwd());
  const reliability = readBlueprint('test-reliability', process.cwd());
  const web = readBlueprint('web-app', process.cwd());

  // library: a row for the changelog its summary promises, with a reason and a gate.
  assert.match(library.summary, /changelog/u);
  const changelog = library.rules.filter((entry) => /\bchangelog\b/u.test(entry.text));
  assert.equal(changelog.length, 1, 'library files one rule for the changelog it promises');
  assert.ok(changelog[0].why.trim() && changelog[0].gate.trim(), 'the changelog rule gives a reason and names a gate');

  // LIB1 and LIB2 carry a machine check: a test file their own starter's check runs, not review.
  for (const key of ['LIB1', 'LIB2']) {
    const { gate } = rule(library, key);
    assert.match(gate, /^test\/[\w.-]+\.test\.js$/u, `${key} names a test file as its gate, a machine check`);
    assert.ok(library.items.some((item) => item.cites.includes(key) && item.check.includes(gate)), `${key}'s gate is a test its own starter's check runs`);
  }
  // LIB1 keeps its card text and says what holds before 1.0.
  assert.equal(rule(library, 'LIB1').text, 'A breaking change bumps the major version.');
  assert.match(ruleText(rule(library, 'LIB1')), /before 1\.0[^.]*\bminor\b/u, 'LIB1 says a breaking change bumps the minor version before 1.0');

  // test-reliability: a flake fix is proven by repeated runs, with a question for the run count.
  const proven = reliability.rules.find((entry) => entry.text === 'A flake fix is proven by repeated runs.');
  assert.ok(proven, 'test-reliability carries "A flake fix is proven by repeated runs."');
  assert.match(proven.gate, /\brun\b.*\bin a row\b/u, 'the flake-fix rule is gated on the repeated runs themselves');
  const runs = reliability.questions.find((entry) => /\bruns in a row\b/u.test(entry.ask));
  assert.ok(runs, 'test-reliability asks how many runs in a row prove a flake fix');
  assert.ok(runs.choices.length <= 12 && runs.choices.every((choice) => /^\d+$/u.test(choice)), 'the run count choices are whole numbers, 12 or fewer');
  assert.match(proven.gate, /run count question/u, 'the flake-fix gate points at the run count question');

  // web-app: its tests bind a local port, so a sandboxed agent asks the person, never rewrites them.
  const port = web.rules.filter((entry) => /\blocal port\b/u.test(entry.text));
  assert.equal(port.length, 1, 'web-app says its tests bind a local port');
  assert.match(port[0].text, /sandbox[^.]*asks the person instead of rewriting the tests/u, 'a sandboxed agent asks the person instead of rewriting the tests');

  // Every row marked must names a gate, in every bundled file, so an approved row passes spec check.
  for (const name of bundledBlueprints()) {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, `../src/shell/blueprints/${name}.json`), 'utf8'));
    for (const entry of raw.rules ?? []) {
      if (entry.tier !== 'must') continue;
      assert.ok(typeof entry.gate === 'string' && entry.gate.trim(), `${name} ${entry.key} is marked must and names a gate`);
      assert.doesNotMatch(entry.gate, UNSAFE_CHECK, `${name} ${entry.key}'s gate runs nothing unsafe`);
    }
  }

  // The new and changed rows round-trip through blueprint save exactly as written. Save keeps a
  // question only when its row reads back one way, so the run count's default sits between choices.
  const rows = [
    ...[rule(library, 'LIB1'), rule(library, 'LIB2'), changelog[0], proven, port[0]].map((entry, index) => `- R${index + 1} [approved, must] ${ruleText(entry)} | gate: review`),
    `- R9 [approved, must] ${questionText(runs)} | gate: review`,
  ];
  const saved = saveBlueprint(parseSpec(`# Spec\n\n## R · Rows\n\n${rows.join('\n')}\n`), { names: [] });
  assert.deepEqual(saved.left, [], 'no new or changed row is left out of a save');
  assert.deepEqual(saved.blueprint.questions.map(({ ask, choices, default: answer }) => ({ ask, choices, default: answer })), [{ ask: runs.ask, choices: runs.choices, default: runs.default }]);
  assert.equal(saved.blueprint.rules.length, 5);
});

test('blueprint commands say what they did [S1,I1]', () => {
  // Every file's bytes outside Git's object store (seat-timing.jsonl is per-command telemetry, not board state), and every board event, so a repeat add is proven to change nothing.
  const snapshot = (box) => {
    const files = readdirSync(box.repo, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.includes(`${join('.git', 'objects')}`) && !/board\.sqlite/u.test(path) && !/seat-timing\.jsonl$/u.test(path))
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
  assert.equal(existsSync(join(unknown.repo, '.git', 'pullboard')), false, 'no board is created');
  const fetched = unknown.run('init', '--blueprint', 'https://example.invalid/web-app.json', '--json');
  assert.notEqual(fetched.status, 0);
  assert.equal(JSON.parse(fetched.stdout).error.code, 'BLUEPRINT_URL');
  assert.deepEqual(readdirSync(unknown.repo).filter((name) => name !== '.git'), [], 'a URL writes nothing');
  assert.equal(existsSync(join(unknown.repo, '.git', 'pullboard')), false, 'a URL creates no board');

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
