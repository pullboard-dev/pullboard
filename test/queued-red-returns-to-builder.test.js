/** A refused queued gate stays with its builder, who reads the exact cause first [V4,H16,N2,R2]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../apps/lib/index.js';
import { claim, firstRefusal, getItem, queuedRedLines, register, submitHandoff } from '../packages/store/index.js';

/** Require authentic command success before reading its JSON document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Require authentic text command success and return its printed lines. */
function lines(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result.out.split('\n').filter(Boolean);
}

/** Read the real SQLite state under an optional injected clock, never writing anything. */
function read(box, id, clock) {
  const board = openBoard(box.boardFile, clock);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** A real project whose accepted main carries an empty cells plan, so an unplaced source is refused after queueing. */
function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true },
    lanes: { ...config.lanes, web: { ...config.lanes.web, owns: ['web/', 'src/', 'bin/'] } } }, null, 2) + '\n');
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  writeFileSync(join(box.repo, 'bin/cells-plan.json'), JSON.stringify({ version: 1, cells: [], stays: [] }) + '\n');
  box.git(box.repo, 'add', 'pullboard.json', 'bin/cells-plan.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure queued submit with a cells plan [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const add = title => document(box.run(box.repo, 'add', 'web', title, '--specs', 'G1',
    '--criterion', `${title} passes its gate.`, '--check', 'true', '--wait', '--json')).item.item_id;
  const ids = [add('Refused queued build'), add('Green queued build'), add('Later build')];
  t.after(async () => {
    for (const id of ids) {
      const job = read(box, id).job;
      if (job) await helpers.waitFor(() => !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', read(box, id).job.id, 'source')),
        'queued worker cleanup', 120000); // budget: hang ceiling for the real detached worker's cleanup; no elapsed-time assertion.
    }
    helpers.cleanup();
  });
  return { ...box, helpers, ids };
}

/** Wait for a real queued job to reach a terminal state. */
async function terminal(box, id) {
  await box.helpers.waitFor(() => ['red', 'green', 'submitted', 'incomplete'].includes(read(box, id).job?.state),
    `queued gate #${id} finishes`, 120000); // budget: hang ceiling for the real detached worker; no elapsed-time assertion.
  return read(box, id);
}

test('a refused queued gate stays claimed by its seat, leads next, inbox and claim, shows in show, and opens only after its lease [V4,H16,N2,R2]', async t => {
  const box = fixture(t);
  const [refused, green, later] = box.ids;
  const first = document(box.run(box.web, 'claim', String(refused), '--json')).itemFolder;
  const second = document(box.run(box.web, 'claim', String(green), '--json')).itemFolder;
  assert.equal(box.helpers.commitFile(box, first, 'src/unplaced.js', 'export const unplaced = true;\n', 'feat(web): unplaced source [G1]').status, 0);
  assert.equal(box.helpers.commitFile(box, second, 'web/green.txt', 'green\n', 'feat(web): placed work [G1]').status, 0);
  assert.equal(document(box.run(first, 'submit', String(refused), '--no-next', '--json')).queued, true);
  assert.equal(document(box.run(second, 'submit', String(green), '--no-next', '--json')).queued, true);
  const red = await terminal(box, refused);
  await terminal(box, green);

  // The worker's retained refusal names the file; the item stays claimed by the seat that submitted it.
  assert.equal(red.job.state, 'red');
  assert.equal(red.job.error.code, 'CELLS_PLAN_UNPLACED');
  assert.match(red.job.error.message, /src\/unplaced\.js/u);
  const retained = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', red.job.id, 'refusal.json'), 'utf8'));
  assert.deepEqual(red.job.error, retained.error);
  assert.equal(red.item.item_status, 'claimed');
  assert.equal(red.item.item_owner, red.job.agentId);
  assert.ok(Date.parse(red.item.item_lease_until) > Date.now(), 'a fresh lease from the red result');
  assert.equal(read(box, green).item.item_status, 'submitted', 'the seat\'s other submission is untouched');

  const expected = [
    `red queued gate on #${refused} Refused queued build: CELLS_PLAN_UNPLACED: ${red.job.error.message}`,
    `next: ${red.job.error.next}`,
  ];
  // next, inbox and claim from that seat print the red first, before any other work.
  assert.deepEqual(lines(box.run(box.web, 'next')).slice(0, 2), expected);
  assert.deepEqual(lines(box.run(box.web, 'inbox')).slice(0, 2), expected);
  const shown = lines(box.run(box.web, 'show', String(refused))).join('\n');
  assert.match(shown, new RegExp(`queued gate: red at ${red.job.executionCommit}\\nCELLS_PLAN_UNPLACED: ${red.job.error.message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\nnext: `, 'u'));
  assert.deepEqual(lines(box.run(box.web, 'claim', String(later))).slice(0, 2), expected);

  // Only after the seat's lease lapses without action may anyone else take it.
  const held = read(box, refused).item;
  assert.equal(held.item_owner, red.job.agentId);
  const lapsed = { now: () => new Date(Date.parse(held.item_lease_until) + 1000) };
  const board = openBoard(box.boardFile, lapsed);
  try {
    assert.equal(firstRefusal(board, refused), null, 'no builder reservation outlives the lease');
    const other = register(board, { lane: 'web', path: join(box.dir, 'other-web'), family: 'Fixture other seat' });
    claim(board, refused, { agentId: other, lane: 'web', leaseMs: 60_000, freeze: item => ({ text: item.item_title, digest: 'lapsed-red-fixture' }) });
    assert.equal(getItem(board, refused).item_owner, other);
  } finally { board.db.close(); }
});

test('the red lines carry a refusal naming a file and line verbatim [V4,N2]', () => {
  const error = { code: 'CELLS_SUBMIT', message: 'web/page.js:12: added import through compatibility shim src/board.js; import from packages/store/index.js instead',
    next: 'import from the cell front door, commit, then submit again' };
  assert.deepEqual(queuedRedLines([{ id: 7, title: 'Page', leaseUntil: '2026-11-02T12:00:00.000Z', error }]), [
    `red queued gate on #7 Page: CELLS_SUBMIT: ${error.message}`,
    `next: ${error.next}`,
    '#7 stays claimed by you until 2026-11-02T12:00:00.000Z; fix it, commit, then pullboard submit 7',
  ]);
});
