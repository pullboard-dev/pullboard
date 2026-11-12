/** Busy, held and pending work always has an actionable next step [C7,N41,N42]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  nextSteps$NEXT_STEPS,
  nextSteps$nextStepFor,
} from '../../index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Create a real joined CLI fixture whose seat has an explicit model. */
function project() {
  const box = e2e.sandbox();
  box.env.PULLBOARD_MODEL = 'No-wait fixture model';
  // Resume prose needs no view daemon writing into the fixture while its cleanup removes Git metadata.
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ view: { background: false } }));
  return e2e.project('true', box);
}

/** Add one native item through the coordinator CLI and return its assigned id. */
function add(box, lane, title, options = []) {
  const result = fixtureAdd(box.run, box.repo, lane, title, '--specs', lane === 'api' ? 'G2' : 'G1', ...options, '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out).item.item_id;
}

/** Check only the emitted next step, leaving unrelated resume and refusal details intact. */
function assertActionable(output, action) {
  const line = String(output).split(/\r?\n/u).findLast(value => /^next:\s*/iu.test(value));
  assert.ok(line, output);
  const next = line.replace(/^next:\s*/iu, '');
  assert.match(next, /pullboard next(?: --verify)?|nothing for this seat: end your turn/iu);
  assert.doesNotMatch(next, /\bwait\b|--wait/iu);
  if (action) assert.match(next, action);
}

/** Check the specific held refusal's own recovery prose without scanning unrelated output. */
function assertNoWaitInRefusal(output, code) {
  const refusal = String(output).split(/\r?\n/u).findLast(value => value.includes(code));
  assert.ok(refusal, output);
  assert.doesNotMatch(refusal, /\bwait\b|--wait/iu);
}

test('pending refusal defaults and rendered next steps offer work or end the turn [C7,N41,N42]', () => {
  const codes = ['BOARD_BUSY', 'BOARD_LANDS_ACCEPTED', 'REVIEW_NOT_READY', 'RESOURCE_BUSY', 'RUNNER_BUSY',
    'RUNNER_CAPACITY_MISMATCH', 'PERSON_REQUEST_TAKEN', 'RELAY_CONFIRMATION_PENDING', 'ITEM_HELD', 'LANE_HELD'];
  for (const code of codes) {
    const next = nextSteps$NEXT_STEPS[code];
    assert.ok(next, `${code} has a default`);
    assert.match(next, /pullboard next(?: --verify)?|nothing for this seat: end your turn/iu, code);
    assert.doesNotMatch(next, /\bwait\b|--wait/iu, code);
    const rendered = nextSteps$nextStepFor({ code }, `[${code}] fixture refusal`);
    assert.match(rendered, /pullboard next(?: --verify)?|nothing for this seat: end your turn/iu, code);
    assert.doesNotMatch(rendered, /\bwait\b|--wait/iu, code);
  }
});

test('native item and lane holds refuse claims with actionable next steps [C7,N41,N42]', () => {
  const itemBox = project();
  const item = add(itemBox, 'web', 'Held item');
  const itemHold = itemBox.run(itemBox.repo, 'hold', String(item), '--reason', 'fixture item hold');
  assert.equal(itemHold.code, 0, itemHold.err || itemHold.out);
  const itemClaim = itemBox.run(itemBox.web, 'claim', String(item));
  assert.notEqual(itemClaim.code, 0);
  assert.match(itemClaim.err, /ITEM_HELD/u);
  assertNoWaitInRefusal(itemClaim.err, 'ITEM_HELD');
  assertActionable(itemClaim.err, /pullboard next/u);

  const laneBox = project();
  const laneItem = add(laneBox, 'web', 'Lane held item');
  const laneHold = laneBox.run(laneBox.repo, 'hold', 'web', '--reason', 'fixture lane hold');
  assert.equal(laneHold.code, 0, laneHold.err || laneHold.out);
  const laneClaim = laneBox.run(laneBox.web, 'claim', String(laneItem));
  assert.notEqual(laneClaim.code, 0);
  assert.match(laneClaim.err, /LANE_HELD/u);
  assertNoWaitInRefusal(laneClaim.err, 'LANE_HELD');
  assertActionable(laneClaim.err, /pullboard next/u);
});

test('resume offers another step for a held lane, blocked lane work and a pending verdict [C7,N41,N42]', () => {
  const held = project();
  add(held, 'web', 'Held lane work');
  const hold = held.run(held.repo, 'hold', 'web', '--reason', 'fixture lane hold');
  assert.equal(hold.code, 0, hold.err || hold.out);
  const heldResume = held.run(held.web, 'resume');
  assert.equal(heldResume.code, 0, heldResume.err);
  assertActionable(heldResume.out, /take work in another lane/u);

  const blocked = project();
  const prerequisite = add(blocked, 'api', 'Open prerequisite');
  add(blocked, 'web', 'Blocked by prerequisite', ['--after', String(prerequisite)]);
  const blockedResume = blocked.run(blocked.web, 'resume');
  assert.equal(blockedResume.code, 0, blockedResume.err);
  assertActionable(blockedResume.out, /another eligible review or other offered work/u);

  const awaiting = project();
  const submitted = add(awaiting, 'web', 'Pending review');
  const claim = awaiting.run(awaiting.web, 'claim', String(submitted));
  assert.equal(claim.code, 0, claim.err || claim.out);
  const committed = e2e.commitFile(awaiting, awaiting.web, 'web/page.html', '<main>pending</main>', 'feat(web): add pending page [G1]');
  assert.equal(committed.status, 0, committed.failure || committed.stderr);
  const send = awaiting.run(awaiting.web, 'submit', String(submitted));
  assert.equal(send.code, 0, send.err || send.out);
  const awaitingResume = awaiting.run(awaiting.web, 'resume');
  assert.equal(awaitingResume.code, 0, awaitingResume.err);
  assertActionable(awaitingResume.out, /^pullboard next --verify/u);
});
