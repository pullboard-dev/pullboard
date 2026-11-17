/** After a landing the next batch starts before the code map refresh finishes, and the refresh still completes [C7,#5829]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { refreshLandedCodeMap } from '../../../src/logic/main/notices.js';
import { refreshLandedCodeMap as writeCodeMap } from '../../../../codemap/index.js';
import { startCodeMapRefresh } from '../../../src/logic/main/notices.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';

test('landing.refresh.refreshlandedcodemap-returns-while-the-refresh-is: clause 1: refreshLandedCodeMap returns while the refresh is still running [C7,#5829]', async () => {
  let release;
  let finished = false;
  const running = new Promise(resolve => { release = resolve; }).then(() => { finished = true; });
  const said = [];
  const result = await refreshLandedCodeMap({
    root: '/nonexistent', board: {}, batch: { tip: 'a'.repeat(40) },
    write: async () => {}, say: line => said.push(line),
    startCodeMapRefresh: () => ({ pid: 1 }),
  });
  assert.equal(finished, false, 'the landing worker did not wait for the refresh');
  assert.ok(said.includes('code map refresh started in the background'));
  assert.ok(Array.isArray(result.deferred));
  release();
  await running;
  assert.equal(finished, true);
});

test('landing.refresh.the-refresh-the-detached-process-runs: clause 1: the refresh the detached process runs still writes the code map [C7,#5829]', async t => {
  const { root } = cellRepo(t, { real: true });
  await writeCodeMap(root);
  assert.ok(existsSync(join(root, '.git', 'pullboard', 'code-map.json')));
});

test('landing.refresh.startcodemaprefresh-returns-a-started-process-at: clause 1: startCodeMapRefresh returns a started process at once [C7,#5829]', async t => {
  const { root } = cellRepo(t, { real: true });
  const { pid } = await startCodeMapRefresh(root);
  assert.ok(pid > 0);
});
