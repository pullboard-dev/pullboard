/** Count distinct sentinel subjects from a real native fixture, without changing its recorded findings [A6,N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../../cli/tests/fixtures/board.js';
import { activityModel } from '../../../view/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';

/** Create a real isolated repository and SQLite board; no host settings or registered machines are changed. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-stuck-subjects-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Sentinel Test', GIT_AUTHOR_EMAIL: 'sentinel@example.invalid',
    GIT_COMMITTER_NAME: 'Sentinel Test', GIT_COMMITTER_EMAIL: 'sentinel@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n## A\n- A6 [approved, must] Report stuck work. | gate: review\n');
  runFixtureGit(['add', 'SPEC.md'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', 'test: initialize private stuck fixture [A6]'], { cwd: root, env });
  let epoch = Date.parse('2026-10-30T01:00:00Z');
  const clock = { now: () => new Date(epoch) };
  const board = fixtureBoard(t, { clock });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  store.register(board, { lane: 'coordinator', path: root });
  const seats = [1, 2, 3].map(n => store.register(board, { lane: 'core', path: join(root, `seat-${n}`) }));
  const ids = Array.from({ length: 6 }, (_, n) => store.addItem(board, { by: 'coordinator', lane: 'core',
    title: n ? `Ready item ${n}` : 'One stuck item', criterion: 'The fixture remains readable.', specIds: ['A6'] }));
  store.claim(board, ids[0], { agentId: seats[0], lane: 'core', leaseMs: 3600000,
    freeze: item => ({ text: item.item_title, digest: `fixture:${item.item_id}` }) });
  epoch += 7200000;
  return { board, seats, ids, clock };
}

/** Keep one valid native health finding per observation, including all seat-specific explanations. */
function finding(item, owner, since, suffix = owner, cause = 'CLAIM_LAPSED') {
  return { key: `${cause}:item:${item}:seen:${suffix}`, cause, item, subject: `#${item}`, title: 'claim lapsed', since,
    why: `${owner} observed the expired lease`, next: 'renew the item claim', owner: { who: owner } };
}

test('lib.sentinel-count.one-stuck-item-observed-by-three: one stuck item observed by three seats and five ready items counts one subject on the real board [A6,N26]', t => {
  const box = fixture(t);
  const since = new Date(box.clock.now().getTime() - 3600000).toISOString();
  const findings = box.seats.map(owner => finding(box.ids[0], owner, since));
  const before = store.events(box.board);
  store.recordHealthFindings(box.board, { agentId: 'coordinator', observedRevision: before.at(-1).event_id, findings });
  const events = store.events(box.board);
  const scan = events.filter(event => event.event_kind === 'health-scan').at(-1);
  const active = JSON.parse(scan.event_detail).active;
  assert.equal(active.length, 3, 'native evidence retains all three actual observations');
  const rows = store.listItems(box.board);
  // The canonical reader projects an expired claim as open; its recorded stuck subject is not healthy ready work.
  const stuckIds = new Set(active.map(finding => finding.item));
  const ready = rows.filter(row => row.item_status === 'open' && !stuckIds.has(row.item_id));
  assert.equal(ready.length, 5, 'five ready items really exist');
  assert.deepEqual(ready.map(row => row.item_id).sort((a, b) => a - b), box.ids.slice(1), 'the five actual healthy fixture items are ready');
  const project = { items: rows.map(row => ({ id: row.item_id, status: row.item_status })),
    agents: store.listAgents(box.board), events: [scan] };
  // A history window containing the persisted scan still counts subjects, not notices or seats.
  const run = activityModel(project).rows.find(row => row.kind === 'sentinels');
  assert.equal(run.stuck, 1);
  assert.equal(run.failing, 0);
  assert.equal(run.stillStuck.length, 3, 'count deduplication never deletes reasons or owner evidence');
  assert.deepEqual(store.events(box.board), events, 'presentation changes no board history');
  const embedded = runInNewContext(`(${activityModel.toString()})`, {})(project).rows[0];
  assert.equal(embedded.stuck, 1, 'the actual standalone browser serialization retains the same count');
});

test('lib.sentinel-count.a-new-cause-and-an-old: a new cause and an old cause for one item count once across failing and stuck [A6,N26]', () => {
  const since = '2026-10-30T01:00:00Z';
  const old = finding(1, 'core-1', since, 'old');
  const added = finding(1, 'coordinator', since, 'new', 'HOLD_STALE');
  const event = (id, kind, detail) => ({ event_id: id, event_kind: kind, event_at: since, event_by: 'sentinel',
    item_id: kind === 'health-failure' ? 1 : null, event_detail: JSON.stringify(detail) });
  const run = activityModel({ events: [event(1, 'health-failure', added), event(2, 'health-scan', { active: [old, added] })] }).rows[0];
  assert.equal(run.failing, 1);
  assert.equal(run.stuck, 0, 'one subject is not counted again for its older cause');
  assert.equal(run.findings.length + run.stillStuck.length, 2, 'both causes remain visible');
});

test('lib.sentinel-count.stuck-item-seat-and-runner-identities: stuck item, seat and runner identities remain distinct while repeated causes count once [A6,N26]', () => {
  const entries = [finding(1, 'core-1', '2026-10-30T01:00:00Z'), finding(1, 'core-2', '2026-10-30T01:00:00Z'),
    { cause: 'AGENT_CPU', subject: 'same-name' }, { cause: 'IDLE_AGENT', subject: 'same-name' },
    { cause: 'RUNNER_UNAVAILABLE', subject: 'same-name' }];
  const model = activityModel({ events: [{ event_id: 1, event_kind: 'health-scan', event_at: '2026-10-30T01:00:00Z',
    event_detail: JSON.stringify({ active: entries }) }] });
  assert.equal(model.rows[0].stuck, 3);
  assert.equal(model.rows[0].stillStuck.length, 5);
  const decisions = activityModel({ events: [{ event_id: 2, event_kind: 'health-scan', event_at: '2026-10-30T01:00:00Z',
    event_detail: JSON.stringify({ active: [...entries, { cause: 'DECISION_UNANSWERED', subject: 'decision #1' }] }) }] });
  assert.equal(decisions.rows[0].stuck, 4, 'decision #1 is not the blocked item #1');
});
