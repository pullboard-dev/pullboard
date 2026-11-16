/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { parseSpec } from '../../../../packages/spec/index.js';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';
import { ok } from '../../tests/fixtures/blueprint.js';
import { refusal } from '../../tests/fixtures/blueprint.js';
import { fitDigest } from '../../tests/fixtures/blueprint.js';
import { batchCode } from '../../tests/fixtures/blueprint.js';
import { fitBoard } from '../../tests/fixtures/blueprint.js';

test('a fit proposal waits for the person and keeps its reason [S1,E3]', async () => {
  const { box, seat, key, starter } = fitBoard();
  assert.match((await box.runLocal('help', 'blueprint')).stdout, /^Usage: pullboard blueprint add <name or file>, then a seat runs pullboard blueprint fit .+, then the person runs pullboard spec fit approve <batch>$/mu, 'help blueprint names the fit step');
  const W1 = key('W1');
  const W2 = key('W2');
  const W3 = key('W3');
  const Q1 = key('Q1');
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const criterionBefore = ok(await box.runLocal('show', String(starter('1')), '--json'), 'show').item_criterion;
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
  for (const id of [W1, W2, W3, Q1]) assert.equal(ok(await box.runLocal('spec', 'show', id, '--json'), 'spec show').row.decision, undefined, `${id} has no decision yet`);
  const first = ok(await box.runLocal('show', String(starter('1')), '--json'), 'show');
  assert.equal(first.item_criterion, criterionBefore, 'the starter keeps its criterion');
  assert.equal(ok(await box.runLocal('show', String(starter('2')), '--json'), 'show').item_status, 'open', 'the dropped starter is still open');

  // The person sees every proposal together: in pullboard spec, and in the view's state.
  const listed = await box.runLocal('spec');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /blueprint fit: 6 unverified draft proposals wait for the person; nothing applies until the person approves the batch/u);
  assert.doesNotMatch(listed.stdout, /proposed by/u, 'a recorder is never shown as an authenticated author');
  for (const [target, decision] of proposals) assert.match(listed.stdout, new RegExp(`^  ${target} ${decision} \\(unverified draft, recorded as ${seatId}\\)`, 'mu'), `${target} is listed`);
  assert.match(listed.stdout, new RegExp(`${W3} drop \\(unverified draft, recorded as ${seatId}\\); reason: this repo is a library with no pages; blueprint source: web-app v1 rule W3: Every page works at phone width`, 'u'));
  assert.equal(ok(await box.runLocal('spec', 'fit', '--json'), 'spec fit').proposals.length, 6);
  const out = join(box.dir, 'export');
  assert.equal((await box.runLocal('view', '--export', out)).status, 0);
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
  const reread = ok(await box.runLocal('spec', 'fit', 'edit', W2, 'drop', '--reason', 'the gate already holds main', '--json'), 'person edit');
  assert.equal(reread.proposals.length, 6, 'an edit shows the whole batch again');
  const done = ok(await box.runLocal('spec', 'fit', 'approve', reread.batch, '--json'), 'approve');
  assert.equal(done.proposals.length, 6);
  assert.ok(done.proposals.every((proposal) => proposal.state === 'approved' && proposal.approvedBy === 'person'));
  const w1 = ok(await box.runLocal('spec', 'show', W1, '--json'), 'spec show').row;
  assert.equal(w1.stage, 'approved, pending apply');
  assert.equal(w1.decision.text, adapted, 'the adaptation is the approved text');
  assert.equal(w1.decision.note, `blueprint fit adapt: this repo already tests with node --test; recorded as ${seatId}, unverified; blueprint source: web-app v1 rule W1: Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.`);
  const w3 = ok(await box.runLocal('spec', 'show', W3, '--json'), 'spec show').row;
  assert.equal(w3.stage, 'declined, pending apply');
  assert.equal(w3.reason, 'this repo is a library with no pages', 'the drop keeps its reason');
  assert.match(w3.decision.note, /blueprint source: web-app v1 rule W3: Every page works at phone width before it ships\./u, 'the drop keeps its blueprint source');
  assert.match(ok(await box.runLocal('spec', 'show', W2, '--json'), 'spec show').row.decision.note, /^blueprint fit drop: the gate already holds main; recorded as person, unverified;/u, "the person's edit is what applies");
  assert.equal(ok(await box.runLocal('spec', 'show', Q1, '--json'), 'spec show').row.decision.text, 'The app is built with: Something else. Choices: Next.js, SvelteKit, Rails, Something else.');
  const adaptedItem = ok(await box.runLocal('show', String(starter('1')), '--json'), 'show');
  assert.equal(adaptedItem.item_criterion, 'npm test runs node --test with one passing test');
  const dropped = ok(await box.runLocal('show', String(starter('2')), '--json'), 'show');
  assert.equal(dropped.item_status, 'withdrawn');
  assert.equal(dropped.item_withdrawn_reason, 'blueprint fit drop: there is no home page to fit to a phone');
  const thread = await box.runLocal('show', String(starter('2')));
  assert.match(thread.stdout, /blueprint fit drop: there is no home page to fit to a phone; recorded as web-\S+, unverified; blueprint source: web-app v1 starter 2: The home page works at phone width/u, 'the starter drop keeps its reason and source');

  // The coordinator applies the decisions to SPEC.md as usual.
  const applyResult = await box.runLocal('spec', 'apply');
  assert.equal(applyResult.status, 0, applyResult.stdout + applyResult.stderr);
  const applied = parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows;
  assert.deepEqual([W1, W3].map((id) => applied.find((row) => row.id === id)).map((row) => [row.status, row.text]), [['approved', adapted], ['wont', `${PUBLISHED.rules[2].text} Why: ${PUBLISHED.rules[2].why}`]]);
});

test('an agent cannot approve its own fit proposal [S1,E3,B26]', async () => {
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
  assert.equal(ok(await box.runLocal('spec', 'show', W3, '--json'), 'spec show').row.decision, undefined);
  const first = ok(await box.runLocal('spec', 'fit', '--json'), 'the person reads the batch');
  assert.equal(first.proposals.length, 1);

  // Every refusal below leaves the batch, the reading, SPEC.md and the board as they were.
  const file = join(box.repo, '.git', 'pullboard', 'blueprint-fit.json');
  const readingFile = join(box.repo, '.git', 'pullboard', 'blueprint-fit-viewed.json');
  const refusedWith = async (code, batch, label) => {
    const before = [file, readingFile, join(box.repo, 'SPEC.md')].map((path) => readFileSync(path, 'utf8'));
    const result = await box.runLocal('spec', 'fit', 'approve', batch, '--json');
    assert.equal(refusal(result, label), code, label);
    assert.deepEqual([file, readingFile, join(box.repo, 'SPEC.md')].map((path) => readFileSync(path, 'utf8')), before, `${label}: nothing is persisted`);
    assert.equal(ok(await box.runLocal('spec', 'show', W3, '--json'), 'spec show').row.decision, undefined, `${label}: nothing applied`);
    return JSON.parse(result.stdout).error.message;
  };
  // A proposal changed in the file after the person read it is refused by name.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.proposals.at(-1).reason = 'a different reason slipped in after the reading';
  writeFileSync(file, `${JSON.stringify(stored)}\n`);
  assert.match(await refusedWith('FIT_CHANGED', first.batch, 'approve after an edit'), new RegExp(`^${W3} \\(changed\\) differ from your last reading`, 'u'), 'the refusal names the changed proposal');
  // A proposal that arrives after the reading is refused too; an agent reading the batch does not count.
  const second = ok(await box.runLocal('spec', 'fit', '--json'), 'the person reads it again');
  assert.equal(second.proposals[0].reason, 'a different reason slipped in after the reading');
  const W4 = key('W4');
  ok(seat('blueprint', 'fit', 'legacy-web-app.json', W4, 'keep', '--json'), 'a later proposal');
  ok(seat('spec', 'fit', '--json'), 'the seat reads the batch');
  assert.match(await refusedWith('FIT_CHANGED', second.batch, 'approve after a new proposal'), new RegExp(`^${W4} \\(new\\) differ from`, 'u'), 'the refusal names only the unread proposal');

  // The person reads both. A proposal deleted from the file after that reading is refused by name.
  const third = ok(await box.runLocal('spec', 'fit', '--json'), 'the person reads both');
  assert.equal(third.proposals.length, 2);
  const read = readFileSync(file, 'utf8');
  const readReading = readFileSync(readingFile, 'utf8');
  const both = JSON.parse(read);
  writeFileSync(file, `${JSON.stringify({ ...both, proposals: both.proposals.filter((proposal) => proposal.target !== W4) })}\n`);
  assert.match(await refusedWith('FIT_CHANGED', third.batch, 'approve after a deletion'), new RegExp(`^${W4} \\(gone\\) differ from`, 'u'), 'the refusal names the deleted proposal');
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
  assert.match(await refusedWith('FIT_READING', third.batch, 'approve after the reading was rewritten'), new RegExp(`^${third.batch} is not the batch code of your last reading`, 'u'));
  // The forger's own code fails the same way once the reading is put back, since the batch differs.
  writeFileSync(readingFile, readReading);
  assert.match(await refusedWith('FIT_CHANGED', third.batch, 'approve a forged batch'), new RegExp(`^${W3} \\(changed\\)`, 'u'));

  // An unread proposal given a read one's id, and placed first, is refused by name: ids are never merged.
  writeFileSync(file, read);
  const W5 = key('W5');
  ok(seat('blueprint', 'fit', 'legacy-web-app.json', W5, 'keep', '--json'), 'an unread proposal');
  const withW5 = JSON.parse(readFileSync(file, 'utf8'));
  const unread = withW5.proposals.find((proposal) => proposal.target === W5);
  unread.id = withW5.proposals.find((proposal) => proposal.target === W3).id;
  writeFileSync(file, `${JSON.stringify({ ...withW5, proposals: [unread, ...withW5.proposals.filter((proposal) => proposal !== unread)] })}\n`);
  assert.match(await refusedWith('FIT_FILE', third.batch, 'approve with a shared id'), new RegExp(`^${W5}, ${W3} share a proposal id`, 'u'), 'the refusal names both targets');
  assert.equal(refusal(await box.runLocal('spec', 'fit', '--json'), 'read a batch with a shared id'), 'FIT_FILE');
  assert.equal(ok(await box.runLocal('spec', 'show', W5, '--json'), 'spec show').row.decision, undefined, 'the unread proposal applied nothing');

  // Put back as the person read it, the batch is the person's to approve, with the code they were shown.
  writeFileSync(file, read);
  assert.equal(refusal(await box.runLocal('spec', 'fit', 'approve', '--json'), 'approve with no batch code'), 'USAGE');
  const approved = ok(await box.runLocal('spec', 'fit', 'approve', third.batch, '--json'), 'the person approves');
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
