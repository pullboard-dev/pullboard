// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: a stale verdict shows a stale chip [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { itemRow } from '../../../tests/fixtures/cockpit/harness.js';

test('a stale verdict shows a stale chip [N26,V4]', async () => {
  const box = machine(), alpha = project(box, 'alpha');
  for (const title of ['Stale', 'Fresh', 'Landed', 'Legacy', 'Open']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2, 3, 4]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); }
  box.git(alpha.repo, 'merge', '-q', '--ff-only', alpha.itemBranches.get(`${alpha.baseBranch}:3`));
  await box.inProcess(alpha.repo, 'merged', '3', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--items', '1,2,3,4,5', '--reason', 'Arrange fixture release');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    await page.click({ state: 'all' });
    // Core (#409) publishes verdictState; here the fixture hands it in, a file name with markup included.
    const [one, two, file] = ['a'.repeat(40), 'b'.repeat(40), `web/<b>x</b>&"y'.html`];
    const states = { 1: { code: 'STALE_VERDICT', file, commit: one, main: two }, 3: { code: 'STALE_VERDICT', file, commit: one, main: two }, 4: { code: 'STALE_VERDICT', file: 'web/page-4.html', commit: two, main: one, legacy: true } };
    page.run(`for (const [id, s] of Object.entries(${JSON.stringify(states)})) data.project.items.find((i) => i.id === Number(id)).verdictState = s; render();`);
    const said = (why) => { const t = 'Stale verdict: ' + why + '. Re-review it before it lands.'; return `<span class="chip stale" role="img" title="${t}" aria-label="${t}">stale</span>`; };
    const stale = said(`main changed web/&lt;b&gt;x&lt;/b&gt;&amp;&quot;y&#39;.html in ${one} after this verdict checked it`);
    const legacy = said(`main changed web/page-4.html in ${two} after this verdict checked it (an older receipt, judged from where the claim began)`);
    const marks = (html) => (html.match(/<span class="chip stale"[^>]*>stale<\/span>/g) ?? []).join('');
    const rows = (html, at) => [1, 2, 3, 4].map((id) => marks(html.split('<li').find((row) => row.includes(at(id))) ?? ''));
    assert.deepEqual(rows(page.show('chain'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the list marks the stale and legacy verdicts, never the fresh or merged one');
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">Verified<\/b>/, 'the status stays verified');
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(page.show('chain'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the verified filter still lists them');
    await page.click({ go: 'item:1' });
    assert.equal(marks(page.show('detail')), stale, 'the detail marks it beside the verified chip');
    await page.click({ itemPanelTab: 'verdicts' });
    assert.match(page.show('detail'), /<div class="verdict yes"><b>Accepted · <span title="CRITERION_MET">criterion met<\/span>/, 'the ACCEPT stays in the history with its native reason tooltip');
    await page.click({ go: 'item:3' });
    assert.equal(marks(page.show('detail')), '', 'a merged item carries no mark');
    page.run('view.tab = "roadmap"; render();');
    assert.deepEqual(rows(page.show('roadmap'), (id) => `data-roadmap-key="i:#${id}"`), [stale, '', '', legacy], 'the Roadmap marks the same rows');
    await page.click({ tab: 'shouts' });
    page.run('view.agent = "web-1"; render();');
    assert.deepEqual(rows(page.show('agents').replaceAll('<div class="agent-work"', '<li'), (id) => `data-item="${id}"`), [stale, '', '', legacy], 'the builder holds its stale verdicts in the agent rows');
  } finally { await view.stop(); }
});
