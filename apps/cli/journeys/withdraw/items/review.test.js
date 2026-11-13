// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: a review in progress names its reviewer [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { agentEntries } from '../../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../../tests/fixtures/cockpit/harness.js';

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
