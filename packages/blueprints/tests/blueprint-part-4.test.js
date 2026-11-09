/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { parseSpec } from '../../spec/index.js';
import { assertStarterChecks } from '../../../test/blueprint-starter-fixture.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';
import { PUBLISHED } from './blueprint-fixture.js';
import { freshBoard } from './blueprint-fixture.js';
import { json } from './blueprint-fixture.js';
import { emptyRepo } from './blueprint-fixture.js';
import { bundled } from './blueprint-fixture.js';
import { e2e } from './blueprint-fixture.js';
import { fitDigest } from './blueprint-fixture.js';
import { batchCode } from './blueprint-fixture.js';
import { fitBoard } from './blueprint-fixture.js';
import { ok } from './blueprint-fixture.js';
import { refusal } from './blueprint-fixture.js';

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
