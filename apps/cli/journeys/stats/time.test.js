/** Drives the real native CLI (stats time --json) over a private native history and checks each landed build and its size [B35,R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { TIME_PHASES } from '../../../../packages/stats/index.js';
import { fixture } from '../../../../packages/store/tests/fixtures/stats/time.js';

test('stats time exposes each landed build and its size through the real native CLI [B35,R1,R2,C7]', async t => {
  const { root } = fixture(t); let out = '', err = '';
  const code = await main(['stats', 'time', '--json'], { cwd: root, stdout: { write(text) { out += text; } }, stderr: { write(text) { err += text; } } });
  assert.equal(code, 0, out + err);
  const time = JSON.parse(out).time;
  assert.equal(time.landed, 3, 'the phase report survives alongside build sizes');
  for (const item of time.items) assert.equal(TIME_PHASES.reduce((total, name) => total + item.phases[name], 0), item.clockMs);
  const report = time.builds;
  assert.equal(report.items.length, 3);
  assert.deepEqual(report.over15Minutes.map(row => [row.item, row.buildMinutes, row.size.score]), [[1, 20, 3]]);
});
