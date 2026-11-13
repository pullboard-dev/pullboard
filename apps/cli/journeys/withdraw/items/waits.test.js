// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: each row says what it waits on [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPEC } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';

test('each row says what it waits on [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  let filed = 0;
  // Fixture rows read alike, so every item after the first says why it differs from #1.
  const add = async (lane, title, ...more) => box.inProcess(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...(filed++ ? ['--not-duplicate-of', '1 a distinct fixture row'] : []), ...more);
  await add('web', 'Free');
  await add('web', 'Base');
  await add('web', 'Depends', '--after', '2');
  await add('api', 'Api work');
  await add('web', 'Shipped');
  await add('web', 'Bounced');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  sendBack(box, alpha, 6, 'not yet');
  await box.inProcess(alpha.web, 'claim', '2');
  await box.inProcess(alpha.repo, 'hold', 'api', '--reason', 'API <freeze> until Friday');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const rows = Object.fromEntries(page.show('chain').split('<li class="row').slice(1).map((row) => [/data-item="(\d+)"/.exec(row)[1], {
      stage: /<b class="stage-word">([^<]*)<\/b>/.exec(row)?.[1] || /aria-label="([^:]+):/.exec(row)?.[1],
      detail: /<small class="stage-detail"(?: title="[^"]*")?>([^<]*)<\/small>/.exec(row)?.[1],
      marks: [...row.matchAll(/class="stage-mark[^\"]*"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]),
      gated: /^[^"]*\bgated\b/.test(row),
      waits: [...row.matchAll(/<span class="gate">(.*?)<\/span>/g)].map((match) => match[1]),
    }]));
    assert.deepEqual(rows['1'], { stage: 'Ready', detail: 'strong route', marks: [], gated: false, waits: [] }, 'free to claim');
    assert.deepEqual(rows['2'], { stage: 'Building', detail: 'by web-1 (Test Model)', marks: [], gated: false, waits: [] }, 'a claim names its holder');
    assert.deepEqual(rows['3'], { stage: 'Blocked', detail: 'by #2', marks: [], gated: true, waits: [] }, 'gated on #2, which is still being built');
    assert.deepEqual(rows['4'], { stage: 'Blocked', detail: 'lane api held: API &lt;freeze&gt; until Friday', marks: ['Lane held'], gated: true, waits: ['lane held: API &lt;freeze&gt; until Friday'] });
    assert.deepEqual(rows['5'], { stage: 'In review', detail: 'awaiting a verdict', marks: [], gated: false, waits: [] });
    assert.deepEqual(rows['6'], { stage: 'Ready', detail: 'strong route', marks: ['Sent back'], gated: false, waits: [] });

    await page.click({ go: 'item:2' });
    assert.match(page.show('detail'), /<h2><span class="id">#2<\/span>Base<\/h2>/, 'the gate links to what it waits on');
  } finally {
    await view.stop();
  }
});
