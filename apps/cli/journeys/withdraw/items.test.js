// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: item rows say what they wait on, review and add confirm [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { element } from '../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../tests/fixtures/cockpit/harness.js';
import { agentEntries } from '../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';

test('an added item confirmation names its returned id [A3,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'An existing item', '--specs', 'G1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ids = [];
    for (const title of ['First page item', 'Second page item']) {
      await page.fire('new-item', 'click');
      page.element('add-lane').value = 'web';
      page.element('add-title').value = title;
      page.element('add-specs').value = 'G1';
      await page.fire('add-form', 'submit');
      const item = (await boardOf(view, alpha.repo)).items.find((row) => row.title === title);
      assert.ok(item, 'the real public move creates the submitted item');
      ids.push(item.id);
      assert.equal(page.element('console').className, 'console ok');
      assert.equal(page.element('console').textContent.split('\n').at(-1), `added #${item.id}`);
    }
    assert.notEqual(ids[0], ids[1], 'successive confirmations use their distinct returned ids');
  } finally {
    await view.stop();
  }
});

test('a review in progress names its reviewer [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  await box.inProcess(second, 'join', 'web');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(second, 'next', '--verify');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    assert.match(itemRow(page.show('chain'), 1), /aria-label="In review:/, 'a review keeps the approved lifecycle stage');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail"(?: title="[^"]*")?>web-2 \(Test Model\) verifying<\/small>/, 'the row names who holds the review');
    assert.doesNotMatch(page.show('needs'), /Greeting/, "a review is the agents' work, so it stays out of Needs-you");
    page.run('view.open.idle = true; render();');
    await page.click({ tab: 'shouts' });
    const holds = (id) => agentEntries(page.show('agents')).find((agent) => agent.id === id).holds;
    assert.deepEqual(holds('web-2'), ['#1 Greeting: In review'], 'the reviewer sees the shared verdict stage');
    assert.deepEqual(holds('web-1'), ['#1 Greeting: In review'], 'the builder waits on the same verdict stage');
    await page.click({ tab: 'items' });
    // A name is board text, so it is escaped: give the board on hand a reviewer with markup and redraw.
    page.run('data.project.items.find((i) => i.id === 1).claim.by = "web<b>"; render();');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail"(?: title="[^"]*")?>web&lt;b&gt; verifying<\/small>/);
    await page.run('refresh()');

    box.git(second, 'switch', '-q', '--detach', alpha.branch);
    await box.inProcess(second, 'verify', '1', 'accept', '--note', 'opened the page and read the greeting');
    await page.run('refresh()');
    await page.click({ state: 'all' });
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">Verified<\/b>/, 'once the verdict lands, the review is over');
    await page.click({ tab: 'shouts' });
    assert.deepEqual(holds('web-2'), []);
  } finally {
    await view.stop();
  }
});

test('each row says what it waits on [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  const add = async (lane, title, ...more) => box.inProcess(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
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
    assert.deepEqual(rows['3'], { stage: 'Gated', detail: 'by #2', marks: [], gated: true, waits: [] }, 'gated on #2, which is still being built');
    assert.deepEqual(rows['4'], { stage: 'Gated', detail: 'lane api held: API &lt;freeze&gt; until Friday', marks: ['Lane held'], gated: true, waits: ['lane held: API &lt;freeze&gt; until Friday'] });
    assert.deepEqual(rows['5'], { stage: 'In review', detail: 'awaiting a verdict', marks: [], gated: false, waits: [] });
    assert.deepEqual(rows['6'], { stage: 'Ready', detail: 'strong route', marks: ['Sent back'], gated: false, waits: [] });

    await page.click({ go: 'item:2' });
    assert.match(page.show('detail'), /<h2><span class="id">#2<\/span>Base<\/h2>/, 'the gate links to what it waits on');
  } finally {
    await view.stop();
  }
});
