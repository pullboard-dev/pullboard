/** Projected capacity is plain input; browser layout and live refresh remain journeys [N26,R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeCapacity } from '../../src/logic/home.js';

/** A projected measurement, never a forecast calculated by the browser. */
const CAPACITY = {
  available: true, stale: false, asOf: '2026-10-25T10:00:00Z',
  agents: { recommended: 24, lower: 16, upper: 32 }, finishHours: { lower: 18, upper: 22 },
  binding: { kind: 'rework', text: 'Rework limits useful concurrency.' },
  lever: { text: 'Halve rejects.' }, needsYou: [2, 7], unknown: [],
  curve: [{ agents: 1, hours: 40 }, { agents: 2, hours: 20 }, { agents: 4, hours: 18 }],
  monteCarlo: { asOf: '2026-10-25T10:00:00Z' },
};

test('view.x-home.the-home-capacity-presenter-preserves-unknowns-stale: the home capacity presenter preserves unknowns stale estimates and escaped labels [N26,R1,R2]', () => {
  const projected = { ...CAPACITY, stale: true, binding: { kind: '<b>rework</b>', text: 'A & B' },
    lever: { text: '<img src=x onerror=alert(1)>' }, unknown: ['<script>no</script>', 'Second', 'Third', 'Fourth', 'Fifth', 'Hidden diagnostic'],
    staffing: { measuredLive: false, seats: 4 }, monteCarlo: { asOf: 'earlier <update>' } };
  const html = homeCapacity(projected);
  assert.match(html, /24<\/strong> \(16–32\)/);
  assert.match(html, /Finish in about 18–22 h/);
  assert.match(html, /2 items lack recorded approval evidence/);
  assert.match(html, /Estimates are stale/);
  assert.match(html, /live presence is unknown/);
  assert.match(html, /earlier &lt;update&gt;/);
  assert.match(html, /&lt;b&gt;rework&lt;\/b&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Fifth \(1 more\)/, 'only five diagnostics are shown with the remaining count');
  assert.doesNotMatch(html, /Hidden diagnostic/);
  assert.equal(projected.unknown.length, 6, 'rendering preserves the full projected diagnostics array');
  assert.doesNotMatch(html, /<img|<script|<b>rework/);
  assert.match(html, /<polyline points="/);
  assert.match(html, /lower bounds by agent count; not finish forecasts/);
  const absent = homeCapacity();
  assert.match(absent, /unknown<\/strong>/);
  assert.match(absent, /Finish time: unknown/);
  assert.match(absent, /Capacity estimate is unavailable/);
  assert.match(absent, /Approval evidence count: unknown/);
  assert.doesNotMatch(absent, /0 items lack recorded approval evidence/);
  assert.doesNotMatch(absent, /<polyline/);
  const censored = homeCapacity({ ...CAPACITY, finishHours: { lower: 18, upper: null } });
  assert.match(censored, /Finish time: unknown/, 'a nonfinishing forecast quantile is not invented');
});

