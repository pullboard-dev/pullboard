/** Read the claim, submit, release and merged events that give per-seat flow, read-only [C7,#6136]. */
import { AGENT_FLOW_KINDS } from '../logic/agents.js';

/**
 * Those events up to a moment, in board order.
 *
 * Why: a hold that began before the window still counts inside it, so the read starts at the beginning of the board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{until: number}} window - epoch ms
 * @returns {{kind: string, seat: string, item: number|null, at: number}[]}
 */
export function readAgentFlowEvents(db, { until }) {
  const marks = AGENT_FLOW_KINDS.map(() => '?').join(',');
  return db.prepare(`SELECT event_kind AS kind, event_by AS seat, item_id AS item, event_at AS at FROM event
    WHERE event_kind IN (${marks}) AND event_at < ? ORDER BY event_id`).all(...AGENT_FLOW_KINDS, new Date(until).toISOString())
    .map(row => ({ ...row, at: Date.parse(row.at) }));
}

/**
 * Test starts by seat inside the window, and every event by any seat from the window on, for the wait after a submit or test start [#6137].
 *
 * Why: a wait ends at the seat's next action, which may fall after the window closes, so actions are read to the end of the board; a
 * test's start is the moment its run was queued, and the queue records which seat asked.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{from: number, until: number}} window - epoch ms
 * @returns {{tests: {seat: string, at: number}[], actions: {seat: string, at: number}[]}}
 */
export function readSeatActions(db, { from, until }) {
  const actions = db.prepare('SELECT event_by AS seat, event_at AS at FROM event WHERE event_at >= ? ORDER BY event_id')
    .all(new Date(from).toISOString()).map(row => ({ seat: row.seat, at: Date.parse(row.at) }));
  const tests = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job'").get()) {
    const rows = db.prepare(`SELECT s.job_step_at AS at, s.job_step_payload AS payload FROM job_step s JOIN job j ON j.job_id = s.job_step_job
      WHERE j.job_kind = 'test-run' AND s.job_step_name = 'queued' AND s.job_step_at >= ? ORDER BY s.job_step_id`).all(from);
    for (const row of rows) {
      let seat;
      try { seat = JSON.parse(row.payload)?.agent; } catch { seat = undefined; }
      if (typeof seat === 'string' && seat) tests.push({ seat, at: row.at });
    }
  }
  return { tests, actions };
}
