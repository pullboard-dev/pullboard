/** Cockpit doctrine checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadDoctrine } from '../../src/doctrine.js';
import { SPEC, machine, project, startView, styleOf, openPage } from './fixture.js';


test('the doctrine view carries and labels inherited, local, overridden and declined rules [D3,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Keep <b>local</b> evidence. | gate: review\n- PB2 [approved, must] Deletion needs <i>two</i> approvals. | gate: review\n- PB8 [wont] No <script>persistent</script> data is stored.\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const state = JSON.parse(page.run('JSON.stringify(data.project)'));
    const merged = loadDoctrine(alpha.repo, { practice: 'ways.md' });
    /** Compare the merged reader's row fields without the view's extra display text. */
    const fields = ({ id, status, tier, text, gate, serves, section, origin, version, reason }) => ({ id, status, tier, text, gate, serves, section, origin, version, reason });
    assert.deepEqual(state.practice.map(fields), merged.rows.map(fields), 'state carries the exported merged doctrine, including every source and reason');
    assert.equal(state.practice.length, 13, 'twelve standard ids with two replaced, plus one local id');
    assert.equal(state.practice.filter((row) => row.id === 'PB2').length, 1);
    assert.equal(state.practice.filter((row) => row.id === 'PB8').length, 1);
    assert.equal(state.practice.find((row) => row.id === 'PB8').standardText, 'No secrets or sensitive info in the repo; test data is synthetic.');
    await page.click({ tab: 'doctrine' });
    const list = page.show('doctrine-list');
    // A section says once where its rules come from; a row says so only where it differs from its section.
    const sections = list.split('<div class="spec-section-head">').slice(1).map((chunk) => ({
      source: /<small class="section-source" title="[^"]+">([^<]*)<\/small>/.exec(chunk)?.[1] ?? null,
      rows: chunk.split('<div class="srow').slice(1).map((row) => [/data-row="doctrine:([^"]+)"/.exec(row)[1], /<small class="rule-source" title="[^"]+">([^<]*)<\/small>/.exec(row)?.[1] ?? null]),
    }));
    const where = (id) => { const section = sections.find((s) => s.rows.some(([row]) => row === id)); return [section?.source ?? null, section?.rows.find(([row]) => row === id)[1] ?? null]; };
    assert.deepEqual(where('PB1'), ['From Pullboard', null], `a section of Pullboard's rules says so once, in its header: ${JSON.stringify(sections)}`);
    assert.deepEqual(where('R1'), ['This repo', null], `a rule this repo wrote sits under a header that says so: ${JSON.stringify(sections)}`);
    assert.match(list, /data-row="doctrine:R1"[^]*?Keep &lt;b&gt;local&lt;\/b&gt; evidence\./);
    assert.ok(['This repo,', ',This repo'].includes(where('PB2').join()), `the rule this repo changed says This repo, by its section or by itself: ${JSON.stringify(where('PB2'))}`);
    assert.match(list, /data-row="doctrine:PB2"[^]*?Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    assert.doesNotMatch(list, /Destructive or irreversible actions wait/);
    assert.match(list, /data-row="doctrine:PB8"[^]*?<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s><small class="rule-reason">Reason: No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/small>/);
    assert.doesNotMatch(list, /<script>|<i>two<\/i>|<b>local<\/b>/, 'all repo text stays text');
    const style = await styleOf(view);
    assert.match(style, /\.rule-source, \.rule-reason \{ display: block; color: var\(--ink-muted\);/, 'labels and reasons remain separate readable lines');

    await page.click({ row: 'doctrine:PB1' });
    assert.match(page.show('doctrine-detail'), /<span class="chip" title="Pullboard standard rules, version \d+">From Pullboard<\/span>/);
    await page.click({ row: 'doctrine:PB2' });
    assert.match(page.show('doctrine-detail'), /<span class="chip" title="Written in this repo">This repo<\/span>/);
    assert.match(page.show('doctrine-detail'), /Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    await page.click({ row: 'doctrine:PB8' });
    assert.match(page.show('doctrine-detail'), /<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s>/);
    assert.match(page.show('doctrine-detail'), /<dt>reason<\/dt><dd>No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/dd>/);

    writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Keep newer evidence. | gate: review\n');
    await page.run('seen = ""; refresh()');
    assert.match(page.show('doctrine-list'), /Destructive or irreversible actions wait/);
    assert.doesNotMatch(page.show('doctrine-list'), /Deletion needs|rule-reason|<s>/, 'removing repo overrides restores the inherited rules');
  } finally {
    await view.stop();
  }
});

test('the doctrine pane names DOCTRINE.md and its rules doctrine [D1,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'doctrine-name', SPEC, { practice: 'DOCTRINE.md' });
  writeFileSync(join(alpha.repo, 'DOCTRINE.md'), '# Team\n\n## Team\n- R1 [approved, must] Keep evidence. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'doctrine' });
    const rows = JSON.parse(page.run('JSON.stringify(data.project.practice)'));
    page.run("data.project.practice = []; view.rows.doctrine = 'all'; render()");
    const empty = page.show('doctrine-list');
    assert.match(empty, /No doctrine rows yet: they live in DOCTRINE\.md\./);
    assert.doesNotMatch(empty, /PRACTICE\.md/);

    page.run('data.project.practice = ' + JSON.stringify(rows) + '; render()');
    await page.click({ row: 'doctrine:PB1' });
    const detail = page.show('doctrine-detail');
    assert.match(detail, /override or decline one in DOCTRINE\.md\./);
    assert.doesNotMatch(detail, /PRACTICE\.md/);
    await page.click({ row: 'doctrine:R1' });
    const localDetail = page.show('doctrine-detail');
    assert.match(localDetail, /Rows change in DOCTRINE\.md/);
    assert.doesNotMatch(localDetail, /PRACTICE\.md/);
  } finally {
    await view.stop();
  }
});
