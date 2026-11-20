/** Seeded replay histories for the flow tune journey: version 1 events with no title, path or commit, built here and never copied from a live board [C7,#1099]. */
const MINUTE = 60_000;
const START = Date.parse('2026-11-01T00:00:00.000Z');

/** The version 1 history pullboard flow replay --history reads, from [minute, kind, item, seat] rows. */
function exported(rows) {
  const ordered = [...rows].sort((a, b) => a[0] - b[0]);
  return { version: 1, events: ordered.map(([minute, kind, item, by], index) => ({
    event_id: index + 1, event_at: new Date(START + minute * MINUTE).toISOString(), event_kind: kind, item_id: item, event_by: by })) };
}

/** The one limit the replay starts from: one landing at a time, which is the constraint the tuner relaxes. */
export const TUNE_POLICY = { settings: { landingBatchSize: 1 } };

/**
 * A busy board: forty items claimed ten minutes apart by three builders, reviewed by two reviewers in ten minutes each,
 * and landed in forty minutes each by four landers, so landings are the stage that holds the line.
 */
export function busyHistory() {
  const rows = [];
  for (let item = 1; item <= 40; item += 1) {
    const claim = (item - 1) * 10, submit = claim + 10, reserve = submit + 2, accept = reserve + 10;
    const builder = `core-b${item % 3}`, reviewer = `core-r${item % 2}`;
    rows.push([0, 'add', item, 'core-1'], [claim, 'claim', item, builder], [submit, 'submit', item, builder],
      [reserve, 'reserve', item, reviewer], [accept, 'accept', item, reviewer], [accept + 40, 'merged', item, `core-l${item % 4}`]);
  }
  return exported(rows);
}

/** A one-seat board: one seat builds, reviews and lands thirty items one after another, so no stage has a second seat to relax. */
export function oneSeatHistory() {
  const rows = [];
  for (let item = 1; item <= 30; item += 1) {
    const claim = (item - 1) * 40;
    rows.push([0, 'add', item, 'core-1'], [claim, 'claim', item, 'core-1'], [claim + 10, 'submit', item, 'core-1'],
      [claim + 12, 'reserve', item, 'core-1'], [claim + 22, 'accept', item, 'core-1'], [claim + 40, 'merged', item, 'core-1']);
  }
  return exported(rows);
}
