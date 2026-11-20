/** @pullboard-test-input source-tree */
/** pullboard hold records an owner and a deadline, and refuses a hold without an owner while holds.requireOwner is on [C7,#8540]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliInProcess } from '../../../fixtures/process.js';
import { fixtureSettledMachine } from '../../../fixtures/testkit.js';
import {
  builderRepo,
  privateRepo,
  put,
} from '../../../fixtures/submit/gate.js';

const DAY = 86_400_000;

/** Run one CLI command in this process from the project's main checkout, as the fixture's coordinator. */
async function coordinator(box, ...args) {
  const result = await runCliInProcess(args, { cwd: join(box.dir, 'repo'), env: box.env });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/** The JSON the command printed, which may span lines. */
function answer(run) { return JSON.parse(run.out.slice(run.out.indexOf('{'))); }

/** A project with one open item, on a machine whose holds.requireOwner is as given. */
async function project(t, requireOwner) {
  let box = privateRepo(t);
  if (requireOwner) fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { holds: { requireOwner: true } });
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'] }));
  box = builderRepo(box);
  const added = await coordinator(box, 'add', 'build', 'Held work', '--check', 'true', '--criterion', '1. The work is held [reasoning].');
  assert.equal(added.code, 0, added.err + added.out);
  return box;
}

test('cli.journeys-hold-owner.pullboard-hold-owner-and-deadline-record: clause 1: pullboard hold --owner and --deadline record both on the hold, and a hold without an owner is refused when holds.requireOwner is on [C7,#8540]', async t => {
  const box = await project(t, true);
  const refused = await coordinator(box, 'hold', '1', 'waiting on the design');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /HOLD_OWNER_REQUIRED/u);
  const held = await coordinator(box, 'hold', '1', 'waiting on the design', '--owner', 'lane:build', '--deadline', '2031-05-06T07:08:09Z', '--json');
  assert.equal(held.code, 0, held.err + held.out);
  const result = answer(held);
  assert.equal(result.owner, 'lane:build');
  assert.equal(result.deadline, '2031-05-06T07:08:09.000Z');
  assert.equal((await coordinator(box, 'hold', '1', '--off')).code, 0);
  const defaulted = await coordinator(box, 'hold', '1', 'a default deadline', '--owner', 'a person', '--json');
  assert.equal(defaulted.code, 0, defaulted.err + defaulted.out);
  const record = answer(defaulted);
  assert.equal(Date.parse(record.deadline) - Date.parse(record.heldAt), DAY, 'the default deadline is one day after the hold');
});

test('cli.journeys-hold-owner.with-holds-requireowner-off-a-hold: clause 1: with holds.requireOwner off a hold needs no owner and records none [C7,#8540]', async t => {
  const box = await project(t, false);
  const held = await coordinator(box, 'hold', '1', 'plain hold', '--json');
  assert.equal(held.code, 0, held.err + held.out);
  const result = answer(held);
  assert.equal(result.held, true);
  assert.equal(Object.hasOwn(result, 'owner'), false);
});
