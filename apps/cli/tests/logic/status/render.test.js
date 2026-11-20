/** statusLines turns a collected status summary into the exact lines pullboard status prints, with the board-bound formatters injected [C7,#10760]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusLines } from '../../../src/logic/status/render.js';
import { staffingLines } from '../../../../../packages/stats/light.js';
import { staffingSeats } from '../../../../../packages/stats/light.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { main } from '../../fixtures/native.js';

const format = {
  capacityLines: (forecast) => [`forecast ${forecast.weeks} weeks`],
  usefulBuilderLines: (builders) => [`useful builders ${builders.max}`],
  signingLine: (person) => `signing: ${person.signed ? 'signed' : 'unsigned'}`,
  staleStateLine: (entry) => `${entry.id} ${entry.expired ? 'expired' : 'open'}`,
  runnerDeadlineLine: (run) => `deadline ${run.deadline}`,
  submitInvariantLine: (proposal) => `invariant ${proposal}`,
  diskLines: (disk) => [`disk ${disk.used}`],
  staffingLines: (seats) => `staffing ${seats.builders}/${seats.reviewers}`,
};

/** A summary with every section filled. */
const summary = () => ({
  me: { displayName: 'core-1 (sonnet)' },
  unread: 2,
  mine: [{ item_id: 10 }, { item_id: 11 }],
  noRunnerGates: [7],
  stats: { stages: { open: 5, building: 2 }, accepted: 9, rejected: 1 },
  specApprovalBaseline: { pending: true, invalid: true },
  landingBatch: 'landing batch: 3',
  capacityForecast: { weeks: 4 },
  usefulBuilders: { max: 6 },
  person: { signed: false },
  staleState: {
    holds: [{ id: 'hold-1', expired: true, evidence: { complete: true } }],
    claims: [{ id: 'claim-2', expired: true, evidence: { complete: false }, classificationUnknown: true }],
    reviews: [],
    claimHealth: [
      { id: 3, actor: 'core-2', health: 'waiting', waitingOn: [8, 9], idleMs: 0 },
      { id: 4, actor: 'core-3', health: 'stalled', idleMs: 1_320_000 },
    ],
  },
  needsRescope: [{ id: 12, lane: 'core', route: 'light', reasons: ['too wide', 'no test'] }],
  stalledGates: [{ id: 'job-1', item: 13, text: 'dispatcher is gone' }, { id: 'job-2', item: null, text: 'no worker' }],
  runnerUtilization: { warnings: ['runner r1 is idle'] },
  presenceCounts: { live: 2, idle: 1, gone: 3 },
  capacity: { liveAgents: 2, idleAgents: 1, readyItems: 1 },
  agents: [
    { agent_id: 'core-1', presence: 'live', heartbeatAt: '10:00' },
    { agent_id: 'core-2', presence: 'idle' },
    { agent_id: 'core-9', presence: 'gone' },
  ],
  memoryHeld: [{ agent: 'core-1', item: 10, kind: 'test', repo: 'pullboard' }, { agent: 'core-2' }],
  runnerDeadlines: [{ agent: 'core-1', item: 10, repo: 'pullboard', deadline: '5m' }],
  longestHolds: [{ at: '10:01', heldMs: 900, move: 'submit', step: 'merge', stepMs: 400 }, { at: '10:02', heldMs: 50 }],
  disk: { used: '3 GB' },
  submitInvariantProposals: ['p1'],
  needs: [{ kind: 'agent-approved', text: 'row C1 needs a look', what: 'approve or reject it' }, { kind: 'other', text: 'skipped', what: 'skipped' }],
  relay: { linked: false },
});

const options = (extra = {}) => ({ all: false, reviewQueue: 'review queue: 2 waiting', landing: 'landing: idle', originHint: true, format, ...extra });

test('cli.logic-status-render.a-summary-with-every-section-filled-renders-the-recorded-lines: clause 1: a fixed summary with every section filled renders the recorded status lines [C7,#10760]', () => {
  assert.deepEqual(statusLines(summary(), options()), [
    'core-1 (sonnet): 2 unread shouts; holding #10, #11',
    'top blocker: #7 (in the gate, no runner); next: pullboard runner local, or pullboard submit 7 again',
    'board: 5 open, 2 building',
    'verdicts: 9 accepted, 1 rejected',
    'approval baseline pending: the next coordinator or person command in the main checkout records the existing approved rows; lane work may continue and none are flagged until then',
    'approval baseline unreadable: existing rows need approval evidence; restore a known-good board export to recover the original baseline',
    'review queue: 2 waiting',
    'landing: idle',
    'landing batch: 3',
    'forecast 4 weeks',
    'useful builders 6',
    'signing: unsigned',
    'past half limit: hold-1 expired',
    'past half limit: claim-2 open; inactivity unproven (evidence unknown); blocker classification unknown; shown at shortest possible half-limit',
    'needs re-scope: #12 is not offered to core at the light route; too wide; no test; edit, refreeze or re-route it',
    'waiting: #3 (core-2) waits on #8, #9 to land; the claim is released and the item returns when it lands',
    'stalled: #4 (core-3) idle 22m with no commit, file change, running check or item move; released automatically at 40m',
    'gate job job-1 (#13): dispatcher is gone',
    'gate job job-2: no worker',
    'runner r1 is idle',
    'seats: 2 live, 1 idle, 3 gone',
    'capacity: 2 live, 1 idle, 1 ready item',
    'core-1: live (heartbeat 10:00)',
    'core-2: idle (no local heartbeat)',
    'local memory holds core-1 #10 (test) in pullboard',
    'local memory holds core-2',
    'core-1 #10 in pullboard: deadline 5m',
    'board hold 10:01: 900 ms in submit, slowest step merge 400 ms',
    'board hold 10:02: 50 ms in unknown move',
    'disk 3 GB',
    'invariant p1',
    'row C1 needs a look; approve or reject it',
    'optional: add a GitHub origin and run pullboard relay on to link this board',
  ]);
});

test('cli.logic-status-render.a-quiet-summary-prints-only-the-always-on-lines: clause 1: a quiet summary prints only the always-on lines and the optional ones stay out [C7,#10760]', () => {
  const quiet = {
    ...summary(),
    mine: [], noRunnerGates: [], specApprovalBaseline: null, landingBatch: null, usefulBuilders: null,
    staleState: { holds: [], claims: [], reviews: [] }, needsRescope: undefined, stalledGates: [],
    runnerUtilization: { warnings: [] }, capacity: { liveAgents: 0, idleAgents: 0, readyItems: 2 },
    agents: [], memoryHeld: null, runnerDeadlines: null, longestHolds: undefined, submitInvariantProposals: [], needs: [],
  };
  assert.deepEqual(statusLines(quiet, options({ originHint: false })), [
    'core-1 (sonnet): 2 unread shouts; holding nothing',
    'board: 5 open, 2 building',
    'verdicts: 9 accepted, 1 rejected',
    'review queue: 2 waiting',
    'landing: idle',
    'forecast 4 weeks',
    'signing: unsigned',
    'seats: 2 live, 1 idle, 3 gone',
    'capacity: 0 live, 0 idle, 2 ready items',
    'local memory hold status unavailable; pullboard resources shows the queue',
    'runner wait deadline status unavailable; pullboard resources shows the queue',
    'disk 3 GB',
  ]);
});

test('cli.logic-status-render.all-shows-gone-seats: clause 1: the all option lists gone seats and leaves them out otherwise [C7,#10760]', () => {
  const rows = (all) => statusLines(summary(), options({ all })).filter((line) => line.startsWith('core-9'));
  assert.deepEqual(rows(false), []);
  assert.deepEqual(rows(true), ['core-9: gone (no local heartbeat)']);
});

test('cli.logic-status-render.staffing-line: clause 1: statusLines prints the staffing line from format.staffingLines(summary.staffing) directly after the capacity lines [C7,#11836]', () => {
  const lines = statusLines({ ...summary(), staffing: { builders: 6, reviewers: 1, ratio: 8 } }, options());
  assert.equal(lines[lines.indexOf('forecast 4 weeks') + 1], 'staffing 6/1');
  assert.equal(lines.filter((line) => line.startsWith('staffing ')).length, 1);
  assert.equal(statusLines(summary(), options()).some((line) => line.startsWith('staffing ')), false, 'a summary without staffing prints no staffing line');
});

test('cli.logic-status-render.staffing-input: clause 2: with 6 ready items, no max-useful figure and the default ratio, the line reads "Staffing: 6 builders, 1 reviewer (8:1)" [C7,#11836]', () => {
  const seats = staffingSeats({ ready: 6, maxUseful: null });
  assert.equal(staffingLines(seats), 'Staffing: 6 builders, 1 reviewer (8:1)');
  assert.equal(statusLines({ ...summary(), staffing: seats }, options({ format: { ...format, staffingLines } })).includes('Staffing: 6 builders, 1 reviewer (8:1)'), true);
});

test('cli.logic-status-render.real-status: clause 3: the real status command on a scratch board prints the staffing line from its ready items and puts staffing in the summary [C7,#11836]', async (t) => {
  const box = await fixture(t);
  for (const title of ['First ready item', 'Second ready item']) box.add(title);
  const json = await cli(box, box.root, ['status']);
  assert.equal(json.code, 0, json.out + json.err);
  const { staffing, capacity, usefulBuilders } = json.document;
  assert.deepEqual(staffing, staffingSeats({ ready: capacity.readyItems, maxUseful: usefulBuilders?.max ?? null }));
  assert.ok(staffing.builders > 0, 'the scratch board has ready items to staff');
  let out = '';
  const code = await main(['status'], { cwd: box.root, clock: box.clock, stdout: { isTTY: false, write: (part) => { out += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, out);
  assert.ok(out.split('\n').includes(staffingLines(staffing)), `status prints ${staffingLines(staffing)}`);
});
