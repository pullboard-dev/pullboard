/** A refused queued gate stays with its builder, who reads the exact cause first [V4,H16,N2,R2]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { openBoard } from '../../../lib/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { maintainStaleState } from '../../../../packages/store/index.js';
import { staleStateLimits } from '../../../../packages/store/index.js';
import {
  claim,
  firstRefusal,
  getItem,
  queuedRedLines,
  register,
  submitHandoff,
} from '../../../../packages/store/index.js';

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
  // @pullboard-board-file journey: observe and advance the board file the real CLI submission wrote
  const board = openBoard(box.boardFile, clock);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** The model the fixture's seats join under; join refuses a seat with none. */
const QUEUED_RED_MODEL = 'Queued red fixture model';

/** A real project whose accepted main carries an empty cells plan, so an unplaced source is refused after queueing. */
async function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = QUEUED_RED_MODEL;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true },
    lanes: { ...config.lanes, web: { ...config.lanes.web, owns: ['web/', 'src/', 'bin/'] } } }, null, 2) + '\n');
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/cells.json'), JSON.stringify({ version: 1, cells: [], stays: [] }) + '\n');
  box.git(box.repo, 'add', 'pullboard.json', 'packages/codemap/data/plan/cells.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure queued submit with a cells plan [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // Strong authoring accepts a new item before a capable seat records any light-route diagnosis.
  const add = async (title, criterion = `${title} passes its gate.`) => (await fileFixtureItem(box, box.repo, { lane: 'web', title, criterion,
    args: ['--specs', 'G1'], wait: true, diagnose: false, run: box.runLocal })).item_id;
  const ids = [await add('Cells cut: refused queued build', 'Cells cut: queued red fixture [test]'), await add('Green queued build'), await add('Later build')];
  t.after(async () => {
    for (const id of ids) {
      const job = read(box, id).job;
      const source = job && join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source');
      if (job) await helpers.waitFor(() => !existsSync(source), 'queued worker cleanup', 120000); // budget: hang ceiling for the real detached worker's cleanup; no elapsed-time assertion.
    }
    helpers.cleanup();
  });
  return { ...box, helpers, ids };
}

/** Wait for a real queued worker to remove its private source checkout. */
async function cleaned(box, id) {
  const source = join(box.repo, '.git', 'pullboard', 'submit-handoffs', read(box, id).job.id, 'source');
  await box.helpers.waitFor(() => !existsSync(source), `queued worker #${id} cleans up`, 120000); // budget: hang ceiling for the real detached worker's cleanup; no elapsed-time assertion.
}

/** Wait for a real queued job to reach a terminal state. */
async function terminal(box, id) {
  const done = () => ['red', 'green', 'submitted', 'incomplete'].includes(read(box, id).job?.state);
  await box.helpers.waitFor(done, `queued gate #${id} finishes`, 120000); // budget: hang ceiling for the real detached worker; no elapsed-time assertion.
  return read(box, id);
}

/**
 * Put the placement refusal past its trial in the fixture's own ledger, so the next unplaced source is refused and
 * not only reported. Why: machinery refusals start in report mode on a fresh repository (#2611) under an identity
 * bound to the rule's content, so a real probe submit records that identity first and the ledger is then aged.
 */
async function enforcePlacement(box) {
  // A queued gate reads only a completed accepted-cells inventory and ends as infrastructure when main's is cold, so the
  // fixture's own producer run finishes it first (the real producer is a background process the fixture never starts); same as #2934's probe.
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try { await warmAcceptedCells(box.repo, box.git(box.repo, 'rev-parse', 'main'), { withCheckout: withMainCheckout, withLock: withFileLock }); }
  finally { if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome; }
  const probe = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Cells cut: placement trial probe',
    criterion: 'Cells cut: probe the placement trial [test]', args: ['--specs', 'G1'], wait: true, diagnose: false, run: box.runLocal })).item_id;
  box.ids.push(probe);
  const folder = document((await box.runLocal(box.web, 'claim', String(probe), '--json'))).itemFolder;
  assert.equal(box.helpers.commitFile(box, folder, 'src/probe.js', 'export const probe = true;\n', 'feat(web): probe source [G1]').status, 0);
  assert.equal(document((await box.runLocal(folder, 'submit', String(probe), '--no-next', '--json'))).queued, true);
  await terminal(box, probe);
  const file = join(box.repo, '.git', 'pullboard', 'refusal-trials.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const rows = Object.values(ledger.codes).filter(row => row.code === 'CELLS_PLAN_UNPLACED');
  assert.ok(rows.length, 'the probe recorded the placement trial');
  ledger.gates = 20;
  for (const row of rows) row.start = 0;
  writeFileSync(file, JSON.stringify(ledger) + '\n');
}

test('a refused queued gate stays claimed by its seat, leads next, inbox and claim, shows in show, survives idle maintenance, and opens only after its lease (clause 1) [V4,H16,N2,R2,B4,C7]', async t => {
  const box = await fixture(t);
  await enforcePlacement(box);
  const [refused, green, later] = box.ids;
  const first = document((await box.runLocal(box.web, 'claim', String(refused), '--json'))).itemFolder;
  const second = document((await box.runLocal(box.web, 'claim', String(green), '--json'))).itemFolder;
  assert.equal(box.helpers.commitFile(box, first, 'src/unplaced.js', 'export const unplaced = true;\n', 'feat(web): unplaced source [G1]').status, 0);
  assert.equal(box.helpers.commitFile(box, second, 'web/green.txt', 'green\n', 'feat(web): placed work [G1]').status, 0);
  assert.equal(document((await box.runLocal(first, 'submit', String(refused), '--no-next', '--json'))).queued, true);
  assert.equal(document((await box.runLocal(second, 'submit', String(green), '--no-next', '--json'))).queued, true);
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
    `red queued gate on #${refused} Cells cut: refused queued build: CELLS_PLAN_UNPLACED: ${red.job.error.message}`,
    `next: ${red.job.error.next}`,
  ];
  // next, inbox and claim from that seat print the red first, before any other work.
  // The default loop prints the bounded form: one line per red and a pointer to the full refusal (#2777 once-notice, N41).
  const nextLines = lines((await box.runLocal(box.web, 'next'))).slice(0, 2);
  assert.equal(nextLines[0], `red queued gate on #${refused}: CELLS_PLAN_UNPLACED; pullboard show ${refused} for the full refusal`);
  assert.match(nextLines[1], new RegExp(`^#${refused} stays claimed by you until \\S+; fix it, commit, then pullboard submit ${refused}$`, 'u'));
  assert.deepEqual(lines((await box.runLocal(box.web, 'inbox'))).slice(0, 2), expected);
  const shown = lines((await box.runLocal(box.web, 'show', String(refused)))).join('\n');
  assert.match(shown, new RegExp(`queued gate: red at ${red.job.executionCommit}\\nCELLS_PLAN_UNPLACED: ${red.job.error.message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\nnext: `, 'u'));
  assert.deepEqual(lines((await box.runLocal(box.web, 'claim', String(later)))).slice(0, 2), expected);

  // Idle maintenance at 39 minutes, inside the 40-minute idle limit counted from the red return (#2640), leaves the claim with its builder.
  for (const id of [refused, green]) await cleaned(box, id);
  const idle = { now: () => new Date(Date.parse(red.job.completedAt) + 39 * 60_000) };
  const returned = read(box, refused).item;
  assert.ok(idle.now().getTime() < Date.parse(returned.item_lease_until), 'maintenance runs before the fresh lease ends');
  // @pullboard-board-file journey: observe and advance the board file the real CLI submission wrote
  const maintained = openBoard(box.boardFile, idle);
  try {
    const snapshot = captureLapsedClaims({ clock: idle, config: loadConfig(box.repo) }, maintained, 'coordinator');
    if (snapshot) maintainStaleState(maintained, { agentId: 'coordinator', snapshot, health: {}, claimsOnly: true });
    assert.equal(getItem(maintained, refused).item_status, 'claimed');
    assert.equal(getItem(maintained, refused).item_owner, red.job.agentId, 'the builder keeps its returned claim');
  } finally { maintained.db.close(); }

  // Only after the seat's lease lapses without action may anyone else take it.
  const held = read(box, refused).item;
  assert.equal(held.item_owner, red.job.agentId);
  const lapsed = { now: () => new Date(Date.parse(held.item_lease_until) + 1000) };
  // @pullboard-board-file journey: observe and advance the board file the real CLI submission wrote
  const board = openBoard(box.boardFile, lapsed);
  try {
    assert.equal(firstRefusal(board, refused), null, 'no builder reservation outlives the lease');
    const other = register(board, { lane: 'web', path: join(box.dir, 'other-web'), family: 'Fixture other seat' });
    claim(board, refused, { agentId: other, lane: 'web', leaseMs: 60_000, freeze: item => ({ text: item.item_title, digest: 'lapsed-red-fixture' }) });
    assert.equal(getItem(board, refused).item_owner, other);
  } finally { board.db.close(); }
});

test('a returned red claim left untouched is freed by maintenance once its fresh lease lapses (clause 1) [V4,H16,B4,C7]', async t => {
  const box = await fixture(t);
  await enforcePlacement(box);
  const [refused] = box.ids;
  const folder = document((await box.runLocal(box.web, 'claim', String(refused), '--json'))).itemFolder;
  assert.equal(box.helpers.commitFile(box, folder, 'src/unplaced.js', 'export const unplaced = true;\n', 'feat(web): unplaced source [G1]').status, 0);
  assert.equal(document((await box.runLocal(folder, 'submit', String(refused), '--no-next', '--json'))).queued, true);
  const red = await terminal(box, refused);
  assert.equal(red.job.state, 'red');
  await cleaned(box, refused);
  // Nothing happens after the return: the fresh lease lapses and the stale interval passes.
  const config = loadConfig(box.repo);
  const lapsed = { now: () => new Date(Date.parse(red.item.item_lease_until) + staleStateLimits(config).claim + 60_000) };
  // @pullboard-board-file journey: observe and advance the board file the real CLI submission wrote
  const board = openBoard(box.boardFile, lapsed);
  try {
    const snapshot = captureLapsedClaims({ clock: lapsed, config }, board, 'coordinator');
    assert.ok(snapshot?.claims.some(row => row.id === refused), 'the lapsed returned claim is observed');
    maintainStaleState(board, { agentId: 'coordinator', snapshot, health: config.health ?? {}, claimsOnly: true });
    assert.equal(getItem(board, refused).item_status, 'open', 'maintenance frees the lapsed returned claim');
    assert.equal(getItem(board, refused).item_owner, null);
  } finally { board.db.close(); }
});

test('the red lines carry a refusal naming a file and line verbatim (clause 1) [V4,N2,C7]', () => {
  const error = { code: 'CELLS_SUBMIT', message: 'web/page.js:12: added import through compatibility shim src/board.js; import from packages/store/index.js instead',
    next: 'import from the cell front door, commit, then submit again' };
  assert.deepEqual(queuedRedLines([{ id: 7, title: 'Page', leaseUntil: '2026-11-02T12:00:00.000Z', error }]), [
    `red queued gate on #7 Page: CELLS_SUBMIT: ${error.message}`,
    `next: ${error.next}`,
    '#7 stays claimed by you until 2026-11-02T12:00:00.000Z; fix it, commit, then pullboard submit 7',
  ]);
});
