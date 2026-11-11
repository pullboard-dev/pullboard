/** The board records every agent command's wall time per seat and item, and the seats report summarizes it [C7,N2]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { appendSeatTiming } from '../../../../packages/seats/light.js';
import {
  commandTimingReport,
  commandTimingLines,
} from '../../src/logic/timing.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The finished command rows a checkout's seat-timing file holds. */
function finished(box) {
  return readFileSync(join(box.repo, '.git', 'pullboard', 'seat-timing.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.kind === 'command' && row.phase === 'end');
}

test('clause 1: next, claim, show, heartbeat and submit each leave a wall-time row for the seat and item on the real path [C7,N2]', () => {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Timed cycle', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  for (const args of [['next'], ['claim', id], ['show', id], ['heartbeat'], ['submit', id]]) box.run(box.web, ...args);
  const rows = finished(box).filter(row => row.seat === 'web-1');
  for (const command of ['next', 'claim', 'show', 'heartbeat', 'submit']) {
    const row = rows.find(candidate => candidate.command === command);
    assert.ok(row, `${command} left a timing row`);
    assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0, `${command} row carries its wall time`);
  }
  assert.equal(rows.find(row => row.command === 'claim').item, Number(id), 'a claim row names its item');
  assert.equal(rows.find(row => row.command === 'show').item, Number(id), 'a show row names its item');
});

test('clause 2: a real next then submit cycle shows in the seats report with median, p90, next-to-submit, busy fraction and a flagged 31 s command [C7,N2]', () => {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Reported cycle', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  for (const args of [['next'], ['claim', id], ['submit', id]]) box.run(box.web, ...args);
  const file = join(box.repo, '.git', 'pullboard', 'seat-timing.jsonl');
  const now = Date.now();
  // A stubbed slow command: the only synthetic row, standing in for a 31 s wait no fixture should really take.
  appendSeatTiming(file, { version: 1, id: 'slow-1', seat: 'web-1', item: Number(id), kind: 'command', command: 'next', phase: 'end', start: now - 40_000, end: now - 9_000, durationMs: 31_000 });
  const run = box.run(box.web, 'seats', '--json');
  assert.equal(run.code, 0, `${run.out}\n${run.err}`);
  const { timing } = JSON.parse(run.out);
  const next = timing.commands.find(row => row.command === 'next');
  assert.ok(next && next.count >= 2 && next.medianMs >= 0 && next.p90Ms >= next.medianMs, 'next has a count, median and p90');
  assert.ok(timing.commands.some(row => row.command === 'submit'), 'the real submit is in the report');
  assert.ok(timing.items.some(row => row.item === Number(id) && row.nextToSubmitMs >= 0), 'next-to-submit is reported for the item');
  assert.ok(timing.seats.some(row => row.seat === 'web-1' && row.busyFraction >= 0 && row.busyFraction <= 1), 'the seat has a busy fraction');
  assert.deepEqual(timing.defects.map(row => [row.command, row.seat, row.durationMs]), [['next', 'web-1', 31_000]], 'only the 31 s command is flagged');
  const plain = box.run(box.web, 'seats');
  assert.equal(plain.code, 0, `${plain.out}\n${plain.err}`);
  assert.match(plain.out, /conveyor defect: next took 31\.0s/u, 'the flag is part of the printed report');
});

test('clause 2: median, p90, next-to-submit and busy fraction are computed from the rows, overlaps counted once [C7,N2]', () => {
  const row = (command, seat, item, start, durationMs) => ({ version: 1, id: `${command}${start}`, seat, item, kind: 'command', command, phase: 'end', start, end: start + durationMs, durationMs });
  const report = commandTimingReport([
    row('next', 'a', null, 0, 100), row('claim', 'a', 7, 200, 100), row('submit', 'a', 7, 1000, 500),
    row('show', 'a', 7, 1100, 100), row('show', 'a', 7, 5000, 900), row('show', 'a', 7, 6000, 31_000),
  ]);
  const show = report.commands.find(entry => entry.command === 'show');
  assert.deepEqual([show.count, show.medianMs, show.p90Ms], [3, 900, 31_000]);
  assert.deepEqual(report.items, [{ seat: 'a', item: 7, nextToSubmitMs: 1500 }], 'from the seat\'s last next to the end of the submit');
  const seat = report.seats[0];
  assert.equal(seat.busyMs, 100 + 100 + 500 + 900 + 31_000, 'the show inside the submit span counts once');
  assert.equal(commandTimingLines(report).filter(line => line.includes('conveyor defect')).length, 1);
});

test('clause 3: a full day of rows is summarized from one pass, every seat and command present [C7,N2]', () => {
  const day = 24 * 60 * 60 * 1000, start = Date.now() - day, rows = [];
  const names = ['next', 'claim', 'submit', 'show', 'heartbeat'];
  for (let index = 0; index < 100_000; index += 1) {
    rows.push({ version: 1, id: String(index), seat: `seat-${index % 20}`, item: index % 5 === 0 ? null : index % 400, kind: 'command', command: names[index % 5], phase: 'end',
      start: start + index * 800, end: start + index * 800 + 200, durationMs: 200 + (index % 17) * 10 });
  }
  const report = commandTimingReport(rows);
  assert.equal(report.commands.length, 5);
  assert.equal(report.seats.length, 20);
  assert.equal(report.commands.reduce((sum, row) => sum + row.count, 0), 100_000);
});
