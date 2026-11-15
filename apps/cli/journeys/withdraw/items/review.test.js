// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: a review in progress names its reviewer [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { buildLocal } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../../tests/fixtures/cockpit/harness.js';

/**
 * What the Agents panel shows an agent holding: its row's first item under the group that row sits in (Building, In review or Sent back),
 * as "#id title: group"; an agent with no row holds nothing. The redesigned panel (1e76f95cc4) groups agents by stage, one row each [N26].
 */
function agentHolds(html, id) {
  const held = [];
  let group = '';
  for (const part of html.split(/(?=<div class="sx-grp )|(?=<button class="sx-ag )/u)) {
    const heading = /^<div class="sx-grp [a-z]+">([^<]*)</u.exec(part);
    if (heading) { group = heading[1]; continue; }
    const row = /^<button class="sx-ag [^"]*"[^>]*data-agent="([^"]*)"[^>]*><i[^>]*><\/i><span class="sx-it"><code>(#\d+)<\/code>([^]*?)<\/span>/u.exec(part);
    if (row && row[1] === id) held.push(`${row[2]} ${row[3].replace(/<[^>]*>/gu, '')}: ${group}`);
  }
  return held;
}

test('a review in progress names its reviewer [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  await box.inProcess(second, 'join', 'web');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await buildLocal(box, alpha, 1, 'greeting.html');
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
    const holds = (id) => agentHolds(page.show('agents'), id);
    assert.deepEqual(holds('web-2'), ['#1 Greeting: In review'], 'the reviewer sees the shared verdict stage');
    assert.deepEqual(holds('web-1'), ['#1 Greeting: In review'], 'the builder waits on the same verdict stage');
    await page.click({ tab: 'items' });
    // A name is board text, so it is escaped: give the board on hand a reviewer with markup and redraw.
    page.run('data.project.items.find((i) => i.id === 1).claim.by = "web<b>"; render();');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail"(?: title="[^"]*")?>web&lt;b&gt; verifying<\/small>/);
    await page.run('refresh()');

    box.git(second, 'switch', '-q', '--detach', alpha.branch);
    await box.inProcess(second, 'verify', '1', 'accept', '--note', 'opened the page and read the greeting');
    await page.click({ state: 'all' });
    // The server keeps the board's state, so the page's read catches up with the CLI's verdict after a few refreshes, not the first.
    for (let attempt = 0; attempt < 100 && !/<b class="stage-word">Verified<\/b>/.test(itemRow(page.show('chain'), 1)); attempt++) await page.run('refresh()');
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">Verified<\/b>/, 'once the verdict lands, the review is over');
    await page.click({ tab: 'shouts' });
    assert.deepEqual(holds('web-2'), []);
  } finally {
    await view.stop();
  }
});
