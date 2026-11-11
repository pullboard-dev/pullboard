// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items check: a pipeline claim ages from its recorded deadline [N26,N38]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { earlier } from '../../../tests/fixtures/cockpit/harness.js';

test('Pipeline view dates an expired claim from its recorded deadline [N26,N38]', async () => {
  const box = machine(), alpha = project(box, 'pipeline-lapse');
  const base = Date.now() - 60 * 60_000, commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const at = (minute, write) => earlier(alpha.repo, base + minute * 60_000, write);
  at(0, board => store.addItem(board, { by:'coordinator', lane:'web', title:'Expired claim', specIds:['G1'] }));
  at(10, board => store.claim(board, 1, { agentId:'web-1', lane:'web', leaseMs:30*60_000, head:commit, freeze:()=>({text:'{}',digest:'a'.repeat(64)}) }));
  at(35, board => store.addItem(board, { by:'coordinator', lane:'web', title:'Older open item', specIds:['G1'] }));
  const status = JSON.parse(box.run(alpha.repo, 'status', '--json')).stats.items;
  assert.equal(status.open, 2);
  assert.equal(status.claimed, 0);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    await page.click({itemsView:'pipeline'});
    const open = () => page.show('pipeline').split('data-pipeline-stage="ready"')[1].split('</header>')[1].split('</p>')[0];
    assert.match(open(), /data-go="item:2"/, 'an open item from minute35 is older than a claim that lapses at minute40');
    assert.match(open(), new RegExp(new Date(base+35*60_000).toISOString()), 'the oldest open timestamp is the arrival');
    box.run(alpha.repo, 'withdraw', '2', 'Private fixture now isolates the lapse age');
    await page.run('refresh()');
    assert.match(open(), /data-go="item:1"/);
    assert.match(open(), new RegExp(new Date(base+40*60_000).toISOString()), 'expired claim age starts at its native lease deadline');
  } finally { await view.stop(); }
});

