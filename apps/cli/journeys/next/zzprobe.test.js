/** Scratch probe for #6357: CPU profile of a build seat's next --take on the real-size board [N2]. */
import { test } from 'node:test';
import { Session } from 'node:inspector/promises';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { seedRealSize } from '../../tests/fixtures/next/real-size.js';

test('probe build seat selection [N2]', { timeout: 600_000 }, async t => {
  const box = await fixture(t);
  seedRealSize(box);
  const session = new Session(); session.connect();
  await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 1000 });
  await session.post('Profiler.start');
  process.env.PULLBOARD_NEXT_PROFILE = '1';
  const s = Date.now();
  const run = await cli(box, box.seats.actor.path, ['next', '--take']);
  const wall = Date.now() - s;
  delete process.env.PULLBOARD_NEXT_PROFILE;
  const { profile } = await session.post('Profiler.stop');
  console.log('# WALL', wall, 'code', run.code, 'item', run.document?.item?.item_id ?? run.document?.item_id ?? JSON.stringify(run.document)?.slice(0, 160));
  for (const l of run.err.split('\n').filter(l => l.startsWith('next profile'))) console.log('# ' + l);
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(); for (const id of profile.samples) self.set(id, (self.get(id) ?? 0) + 1);
  const fn = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/.*pullboard[^/]*\//, '').replace(/.*worktrees\/[^/]+\//, '')}:${n.callFrame.lineNumber + 1}`;
  const selfAgg = new Map(), totalAgg = new Map();
  for (const [id, count] of self) {
    selfAgg.set(fn(byId.get(id)), (selfAgg.get(fn(byId.get(id))) ?? 0) + count);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) { const k = fn(byId.get(cur)); if (!seen.has(k)) { seen.add(k); totalAgg.set(k, (totalAgg.get(k) ?? 0) + count); } }
  }
  const total = profile.samples.length;
  console.log('# samples', total);
  for (const [k, v] of [...selfAgg].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('# SELF', v, k);
  for (const [k, v] of [...totalAgg].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log('# TOTAL', v, k);
});
