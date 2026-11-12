/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { readBlueprint } from '../../../../packages/blueprints/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { LEGACY_FRAMEWORK } from '../../tests/fixtures/blueprint.js';
import { freshBoard } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { bundled } from '../../tests/fixtures/blueprint.js';
import { ok } from '../../tests/fixtures/blueprint.js';
import { refusal } from '../../tests/fixtures/blueprint.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { blueprintRowIds } from '../../../../packages/blueprints/index.js';
import { starterStates } from '../../../../packages/blueprints/index.js';
import { boardCreated } from '../../tests/fixtures/blueprint.js';
import { TELEMETRY } from '../../tests/fixtures/blueprint.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { RUNNERS } from '../../tests/fixtures/blueprint.js';
import { FRAMEWORKS } from '../../tests/fixtures/blueprint.js';
import { draftedTexts } from '../../tests/fixtures/blueprint.js';

test('blueprint commands say what they did [S1,I1]', async () => {
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
  const unfiledText = await box.runLocal('blueprint', 'starters', 'web-app');
  assert.equal(unfiledText.status, 0, unfiledText.stdout + unfiledText.stderr);
  for (const item of PUBLISHED.items) assert.ok(unfiledText.stdout.split('\n').includes(`  not filed  ${item.title}`), `${item.title} is listed as not filed:\n${unfiledText.stdout}`);

  // A second add says it is already there, and no file byte and no board event changes.
  const firstAdd = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(firstAdd.items.length, PUBLISHED.items.length, 'the add files every starter');
  const before = snapshot(box);
  const again = await box.runLocal('blueprint', 'add', 'web-app');
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
  const filedText = (await box.runLocal('blueprint', 'starters', 'web-app')).stdout.split('\n');
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

test('blueprint starters reads its own version on a board added before starter links [S1,I1]', async () => {
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

test('blueprint add files a blueprint as drafts after an add stopped part way [S1,I1]', async () => {
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

test('clause 1: init --blueprint starts a board from a blueprint [I1,S1]', async () => {
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

test('blueprint add files a blueprint as drafts and runs nothing it supplies [S1,I1]', async () => {
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
  const text = await box.runLocal('blueprint', 'add', 'checked.json');
  assert.match(text.stdout, /already on this board/u);
  for (const url of ['https://pullboard.dev/blueprints/web-app.json', 'file:///tmp/web-app.json']) {
    const refused = await box.runLocal('blueprint', 'add', url, '--json');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BLUEPRINT_URL');
  }
});

test('a question defaults from the repo it lands in [S1,I1]', async () => {
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

test('a question with nothing to read has no default [S1,I1]', async () => {
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

test('starter items land in a build lane, never the coordinator lane [S1,I1]', async () => {
  const lanesOf = async (box) => (JSON.parse((await box.runLocal('list', '--all', '--json')).stdout).items ?? []).map((item) => item.item_lane);
  const configLanes = (box) => JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes ?? {};

  // A fresh init with a blueprint: init proposes the app lane and the starters are filed in it.
  // The proposal stays unwritten until the agent runs the command init prints, then tells the person (#914).
  const fresh = emptyRepo();
  const started = fresh.run('init', '--blueprint', 'web-app', '--verbose');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.deepEqual(await lanesOf(fresh), Array(PUBLISHED.items.length).fill('app'), 'init files every starter in the lane it proposes');
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
  assert.deepEqual((await lanesOf(laned)).filter((lane) => lane === 'coordinator'), [], 'no starter lands in the coordinator lane');

  // A blueprint that names an existing lane owning no folders, a verifier lane: that lane builds
  // nothing, so every starter goes to the first build lane, and add says so.
  const verifier = freshBoard({ lanes: { tests: { owns: [] } } });
  const web = verifier.run('lane', 'add', 'web', '--owns', 'web/');
  assert.equal(web.status, 0, web.stdout + web.stderr);
  writeFileSync(join(verifier.repo, 'verifier-lane.json'), `${JSON.stringify({ ...PUBLISHED, name: 'verifier-lane',
    items: PUBLISHED.items.map((item) => ({ ...item, lane: 'tests' })) })}\n`);
  const moved = verifier.run('blueprint', 'add', 'verifier-lane.json');
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.deepEqual(await lanesOf(verifier), Array(PUBLISHED.items.length).fill('web'), 'a starter naming a lane that owns no folders goes to the first build lane');
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

test('init takes a product and an architecture blueprint together [S1,I1]', async () => {
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

  const started = await box.runLocal('init', '--blueprint', 'web-app', '--blueprint', 'serverless', '--blueprint', practiceFile, '--json');
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
  const items = JSON.parse((await box.runLocal('list', '--json')).stdout).items ?? [];
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
