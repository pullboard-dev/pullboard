/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { parseSpec } from '../../../../packages/spec/index.js';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { freshBoard } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { bundled } from '../../tests/fixtures/blueprint.js';
import { ok } from '../../tests/fixtures/blueprint.js';
import { refusal } from '../../tests/fixtures/blueprint.js';
import { resolve } from 'node:path';
import { boardCreated } from '../../tests/fixtures/blueprint.js';
import { hostname } from 'node:os';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { e2e } from '../../tests/fixtures/blueprint.js';

test('a second blueprint of the same kind is refused [S1,I1]', async () => {
  // A second product blueprint: refused before anything is written, naming both.
  for (const [first, second, kind] of [['web-app', 'ios-app', 'product'], ['serverless', 'data-pipeline', 'architecture']]) {
    const box = emptyRepo();
    const refused = await box.runLocal('init', '--blueprint', first, '--blueprint', second, '--json');
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
  const listed = async (box) => (JSON.parse((await box.runLocal('list', '--all', '--json')).stdout).items ?? []).length;
  for (const [first, second] of [['web-app', 'other-product.json'], ['other-product.json', 'web-app']]) {
    const sequential = freshBoard();
    writeFileSync(join(sequential.repo, 'other-product.json'), `${JSON.stringify({ ...PUBLISHED, name: 'other-product', title: 'Other product' })}\n`);
    json(sequential, 'blueprint', 'add', first);
    const spec = readFileSync(join(sequential.repo, 'SPEC.md'), 'utf8');
    assert.ok(spec.includes(`<!-- pullboard-blueprint-kind ${first.replace(/\.json$/u, '')} product -->`), 'the add records its kind beside its rows');
    const items = await listed(sequential);
    const later = sequential.run('blueprint', 'add', second, '--json');
    assert.notEqual(later.status, 0, later.stdout);
    assert.equal(JSON.parse(later.stdout).error.code, 'BLUEPRINT_KIND_TAKEN');
    assert.match(JSON.parse(later.stdout).error.message, /(?=.*web-app)(?=.*other-product)/u, 'the refusal names both');
    assert.equal(readFileSync(join(sequential.repo, 'SPEC.md'), 'utf8'), spec, 'a later second product writes no row');
    assert.equal(await listed(sequential), items, 'a later second product files no starter');
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
  const refusedBoth = async (box, first, second, args) => {
    const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
    const items = await listed(box);
    const later = await box.runLocal('blueprint', 'add', ...args, '--json');
    assert.notEqual(later.status, 0, later.stdout);
    const { error } = JSON.parse(later.stdout);
    assert.equal(error.code, 'BLUEPRINT_KIND_TAKEN');
    assert.match(error.message, new RegExp(`^${first} and ${second} `, 'u'), 'the refusal names both');
    assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, 'SPEC.md is unchanged');
    assert.equal(await listed(box), items, 'no starter is filed');
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
  const unknown = await refusedBoth(away, 'legacy-product', 'web-app', ['web-app']);
  assert.match(unknown.next, /record legacy-product's kind with pullboard blueprint add/u, 'the next step says how to resolve it');
  const beforeRecord = readFileSync(join(away.repo, 'SPEC.md'), 'utf8');
  const items = await listed(away);
  assert.equal(json(away, 'blueprint', 'add', awayFile).marked, true, 'adding its file again adds nothing');
  const recorded = readFileSync(join(away.repo, 'SPEC.md'), 'utf8');
  assert.deepEqual(recorded.split('\n').filter((line) => !beforeRecord.split('\n').includes(line)), ['<!-- pullboard-blueprint-kind legacy-product product -->'], 'it records only the kind');
  assert.equal(await listed(away), items);
  await refusedBoth(away, 'legacy-product', 'web-app', ['web-app']);
  assert.equal(json(away, 'blueprint', 'add', 'serverless').blueprint.name, 'serverless', 'an architecture blueprint joins the recorded product');
  // A custom product whose file is still at the repo root: its kind is read from it.
  const home = freshBoard();
  legacyAdd(home, custom(home, 'legacy-product', 'product', home.repo));
  assert.match((await refusedBoth(home, 'legacy-product', 'web-app', ['web-app'])).message, /are both product blueprints/u);
  // A custom practice blueprint: once its kind is recorded, a product joins it.
  const practiced = freshBoard();
  const practiceFile = custom(practiced, 'legacy-practice', 'practice', practiced.dir);
  legacyAdd(practiced, practiceFile);
  await refusedBoth(practiced, 'legacy-practice', 'web-app', ['web-app']);
  json(practiced, 'blueprint', 'add', practiceFile);
  assert.equal(json(practiced, 'blueprint', 'add', 'web-app').blueprint.name, 'web-app', 'a product joins a recorded practice blueprint');
  // A bundled product from an older Pullboard is read from its bundled file; adding it again is a
  // no-op apart from recording its kind.
  const bundledLegacy = freshBoard();
  writeFileSync(join(bundledLegacy.repo, 'other-product.json'), `${JSON.stringify({ ...PUBLISHED, name: 'other-product', title: 'Other product' })}\n`);
  legacyAdd(bundledLegacy, 'web-app');
  await refusedBoth(bundledLegacy, 'web-app', 'other-product', ['other-product.json']);
  const bundledItems = await listed(bundledLegacy);
  assert.equal(json(bundledLegacy, 'blueprint', 'add', 'web-app').marked, true, 'the same bundled blueprint again adds nothing');
  assert.equal(await listed(bundledLegacy), bundledItems);

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

test('a saved board adds back as the same rows [S1]', async () => {
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
  assert.equal((await box.runLocal(box.web, 'shout', 'all', 'private shout narwhal')).code, 0);

  const saved = await box.runLocal(box.repo, 'blueprint', 'save', '--json');
  assert.equal(saved.code, 0, `${saved.err}\n${saved.out}`);
  assert.deepEqual(JSON.parse(saved.out).left.map((entry) => entry.id).sort(), ['G1', 'G2', 'K15', 'K16', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'], 'only clean, exactly readable approved rows leave');
  const file = join(box.repo, 'Dana Whitlock board.blueprint.json');
  const text = readFileSync(file, 'utf8');
  for (const secret of ['web/', '@', 'Dana', 'Whitlock', 'web-1', machine, 'zebra', 'walrus', 'narwhal', 'signers', 'DW', 'items', 'pullboard-blueprint', 'Logs live', 'draft never', 'Deploys go']) {
    assert.ok(!text.includes(secret), `the blueprint never carries ${JSON.stringify(secret)}`);
  }
  const blueprint = JSON.parse(text);
  assert.deepEqual([blueprint.name, blueprint.title], ['my-blueprint', 'My blueprint'], 'the project name never goes in; a neutral default does');
  const named = await box.runLocal(box.repo, 'blueprint', 'save', 'named.json', '--name', 'dana-whitlock', '--json');
  assert.equal(JSON.parse(named.out).error?.code, 'PRIVATE_BLUEPRINT', 'a chosen name that names someone is refused');
  assert.deepEqual(Object.keys(blueprint).sort(), ['blueprint', 'gate', 'name', 'questions', 'rules', 'title', 'version'], 'only allow-listed fields are written');
  assert.deepEqual(blueprint.rules.map((rule) => Object.keys(rule).sort()), [['gate', 'key', 'text', 'tier', 'why'], ['gate', 'key', 'text', 'tier', 'why']]);
  assert.deepEqual(blueprint.questions.map((question) => Object.keys(question).sort()), Array(4).fill(['ask', 'choices', 'default', 'key']));
  assert.equal((await box.runLocal(box.repo, 'blueprint', 'save', '--json')).code, 1, 'an existing file is never overwritten');

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
