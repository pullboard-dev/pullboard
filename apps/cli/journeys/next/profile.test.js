/** `next --take` on the real-size board prints each phase's milliseconds and names the slowest three [N2]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { seedRealSize } from '../../tests/fixtures/next/real-size.js';

/** Run one profiled `next --take` and return its stderr profile rows and measured wall time. */
async function profiled(box, seat) {
  process.env.PULLBOARD_NEXT_PROFILE = '1';
  try {
    const started = performance.now();
    const run = await cli(box, seat.path, ['next', '--take']);
    const wall = performance.now() - started;
    const rows = run.err.split('\n').filter(line => line.startsWith('next profile: '));
    return { run, wall, rows };
  } finally { delete process.env.PULLBOARD_NEXT_PROFILE; }
}

/** The phase rows (name, ms) and the summary line a profile printed. */
function parse(rows) {
  const phases = rows.map(line => /^next profile: (.+) (\d+) ms$/u.exec(line)).filter(Boolean).map(m => ({ phase: m[1], ms: Number(m[2]) }));
  const summary = rows.find(line => /: total \d+ ms; slowest three: /u.test(line));
  return { phases, summary };
}

// One seeded board serves both seats: seeding 230,000 events once keeps the file inside its per-file budget.
test('next --take profiles a build seat and a review seat on the real-size board [N2]', async t => {
  const box = await fixture(t);
  seedRealSize(box);
  for (const [kind, seatName] of [['build', 'actor'], ['review', 'sibling']]) {
    const { run, wall, rows } = await profiled(box, box.seats[seatName]);
    const { phases, summary } = parse(rows);
    for (const row of phases) console.log(`# ${kind} seat: ${row.phase} ${row.ms} ms`);
    console.log(`# ${kind} seat: wall ${Math.round(wall)} ms`);
    await t.test(`clause 1: the ${kind} seat's next --take prints each phase and names the slowest three [N2]`, () => {
      assert.equal(run.code, 0, run.out + run.err);
      assert.ok(phases.length >= 2, `phases printed: ${rows.join(' | ')}`);
      const slowest = phases.slice(0, 3).map(row => row.phase).join(', ');
      assert.ok(summary?.endsWith(`slowest three: ${slowest}`), `the summary names the slowest three phases: ${summary}`);
    });
    await t.test(`clause 2: the ${kind} seat's printed phases add up to within 10% of the command's wall time [N2]`, () => {
      const sum = phases.reduce((total, row) => total + row.ms, 0);
      assert.ok(Math.abs(wall - sum) <= wall * 0.1, `phases sum to ${sum} ms against ${Math.round(wall)} ms of wall time`);
    });
  }
});
