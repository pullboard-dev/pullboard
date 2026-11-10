/** @pullboard-test-input source-tree */
/** Probe [C7]. */
import { test } from 'node:test';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { readPathMap } from '../../../../packages/codemap/index.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';

test('probe path map [C7]', t => {
  const { root } = fixture(t);
  const out = [];
  try { out.push('plan ' + computePlan(root).cells.map(c => c.name)); } catch (e) { out.push('PLANERR ' + e.message); }
  try { out.push('map0 ' + readPathMap(root).size); } catch (e) { out.push('MAP0ERR ' + e.stack.split('\n').slice(0, 5).join(' / ')); }
  try { writePlan(root, computePlan(root)); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'p'); out.push('files ' + git(root, 'ls-files').split('\n').join(' ')); } catch (e) { out.push('WRITEERR ' + e.message); }
  try { out.push('map1 ' + readPathMap(root).size); } catch (e) { out.push('MAP1ERR ' + e.stack.split('\n').slice(0, 5).join(' / ')); }
  throw new Error('PROBE ' + out.filter(line => !line.startsWith('plan')).map(line => line.startsWith('files') ? line.split(' ').filter(x => /path-map|seed/.test(x)).join(' ') : line).reverse().join(' || '));
});
