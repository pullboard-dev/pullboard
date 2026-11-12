// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit doctrine checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadDoctrine,
  standardDoctrine,
} from '../../../../packages/doctrine/index.js';
import {
  tapTarget,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  SPEC,
  machine,
  project,
  startView,
  styleOf,
  openPage,
} from '../../tests/fixtures/cockpit/harness.js';


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
    /** Read each rendered row's own source label rather than relying on section metadata. */
    const where = (id) => {
      const row = list.split('<div class="srow').slice(1).find((chunk) => chunk.includes('data-row="doctrine:' + id + '"'));
      return /<span class="rule-source-chip [^"]+" title="[^"]+">([^<]*)<\/span>/.exec(row)?.[1] ?? null;
    };
    /** Preserve packaged version and override history in the source chip's hover text. */
    const sourceTitle = (id) => {
      const row = list.split('<div class="srow').slice(1).find((chunk) => chunk.includes('data-row="doctrine:' + id + '"'));
      return /<span class="rule-source-chip [^"]+" title="([^"]+)">/.exec(row)?.[1] ?? null;
    };
    assert.equal(where('PB1'), 'Standard', 'an inherited rule uses the standard source chip');
    assert.equal(sourceTitle('PB1'), 'Pullboard v' + merged.version, 'the full packaged version remains available on hover');
    assert.equal(where('R1'), 'This repo', 'a local row uses the repository source chip');
    assert.match(list, /data-row="doctrine:R1"[^]*?Keep &lt;b&gt;local&lt;\/b&gt; evidence\./);
    assert.equal(where('PB2'), 'This repo', 'an overridden standard row is now repository-owned');
    assert.equal(sourceTitle('PB2'), 'Pullboard v' + merged.version + ', overridden here', 'the hover text retains the override history');
    assert.match(list, /data-row="doctrine:PB2"[^]*?Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    assert.doesNotMatch(list, /Destructive or irreversible actions wait/);
    assert.match(list, /data-row="doctrine:PB8"[^]*?<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s>[^]*?<span class="rule-reason"[^>]*>Reason: No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/span>/);
    assert.doesNotMatch(list, /<script>|<i>two<\/i>|<b>local<\/b>/, 'all repo text stays text');
    const style = await styleOf(view);
    assert.match(style, /\.rule-source-chip\.standard \{ background: var\(--blue-soft\); color: var\(--blue\); \}/, 'standard source chips use the blue-soft palette');
    assert.match(style, /\.rule-source-chip\.repo \{ background: var\(--surface-2\); color: var\(--ink-muted\); \}/, 'repository source chips stay quiet');

    await page.click({ row: 'doctrine:PB1' });
    assert.match(page.show('doctrine-detail'), /<span class="chip rule-source-chip standard" title="Pullboard v\d+">Standard<\/span>/);
    await page.click({ row: 'doctrine:PB2' });
    assert.match(page.show('doctrine-detail'), new RegExp('<span class="chip rule-source-chip repo" title="Pullboard v' + merged.version + ', overridden here">This repo</span>'));
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
    assert.match(detail, /Approve it to keep it, or override or decline it in DOCTRINE\.md\./);
    assert.doesNotMatch(detail, /PRACTICE\.md/);
    await page.click({ row: 'doctrine:R1' });
    const localDetail = page.show('doctrine-detail');
    assert.doesNotMatch(localDetail, /Rows change in/, 'a local row does not repeat who approves rows (#822)');
    assert.doesNotMatch(localDetail, /PRACTICE\.md/);
  } finally {
    await view.stop();
  }
});

test('a row detail does not repeat who approves rows [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'row-detail-approval', SPEC, { practice: 'DOCTRINE.md' });
  writeFileSync(join(alpha.repo, 'DOCTRINE.md'), '# Team\n\n## Team\n- R1 [approved, must] Keep evidence. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'spec' });
    await page.click({ row: 'spec:G1' });
    const spec = page.show('spec-detail');
    assert.match(spec, /G1/, 'the spec row detail is open');
    assert.doesNotMatch(spec, /Rows change in/, 'a spec row does not repeat who approves rows');
    await page.click({ tab: 'doctrine' });
    await page.click({ row: 'doctrine:R1' });
    const local = page.show('doctrine-detail');
    assert.match(local, /R1/, 'the local doctrine row detail is open');
    assert.doesNotMatch(local, /Rows change in/, 'a local doctrine row does not repeat who approves rows');
    await page.click({ row: 'doctrine:PB1' });
    assert.match(page.show('doctrine-detail'), /Standard rules come with Pullboard as defaults to review\. Approve it to keep it, or override or decline it in DOCTRINE\.md\./,
      'a standard rule keeps its note');
  } finally {
    await view.stop();
  }
});

/** Keep a doctrine row's real item citations when the person leaves and returns to the tab. */
// Hang ceiling: two real Chrome viewport journeys; no speed assertion.
test('the doctrine detail keeps its citing items after a tab round trip [N26,C7]', { timeout: 30_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Doctrine tab round-trip check.');

  const box = machine();
  const repo = project(box, 'doctrine-tab-round-trip', SPEC, { practice: 'DOCTRINE.md' });
  writeFileSync(join(repo.repo, 'DOCTRINE.md'), '# Team rules\n\n## Team\n'
    + '- R1 [approved, must] Keep local notes accurate. | gate: web test\n'
    + '- G1 [approved, must] Keep the page useful. | gate: web test\n');
  await box.inProcess(repo.repo, 'add', 'web', 'First citation', '--specs', 'G1', '--criterion', 'The first item cites G1.');
  await box.inProcess(repo.repo, 'add', 'web', 'Second citation', '--specs', 'G1', '--criterion', 'The second item cites G1.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-tab-round-trip-chrome-'));
  let chrome;
  /** Capture the returned pane, selected doctrine rule and actual citation rows for failure diagnosis. */
  const readDetail = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const pane = document.querySelector('[data-pane="doctrine"]');
    const detail = document.querySelector('#doctrine-detail');
    const heading = detail?.querySelector('h2 span');
    const links = detail?.querySelector('.links');
    const target = links?.querySelector('[data-item="2"]');
    const box = target?.getBoundingClientRect();
    return { tab:document.querySelector('[data-tab="doctrine"]')?.classList.contains('on'), paneHidden:!!pane?.hidden,
      detailOpen:!!heading,
      heading:heading?.textContent ?? null, linksPresent:!!links,
      itemIds:[...(links?.querySelectorAll('[data-item]') ?? [])].map(row => row.dataset.item),
      targetPresent:!!target, targetVisible:!!box && box.width > 0 && box.height > 0 };
  })())`));

  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.practice?.some(row => row.id === "G1") && data?.project?.items?.some(item => item.id === 2 && item.specs.includes("G1"))');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await press(chrome, "document.querySelector('[data-tab=doctrine]')");
      await press(chrome, "document.querySelector('#doctrine-chips [data-rows=\"doctrine:all\"]')");
      await press(chrome, "document.querySelector('#doctrine-list [data-row=\"doctrine:G1\"]')");
      await chrome.waitFor("document.querySelector('#doctrine-detail .links [data-item=\"2\"]')");
      const before = await readDetail();
      assert.equal(before.heading, 'G1', `${width}px: the cited Doctrine rule is selected before leaving`);
      assert.equal(before.targetPresent, true, `${width}px: the live Doctrine detail contains the second real citing item`);
      assert.equal(before.targetVisible, true, `${width}px: the live Doctrine citation is rendered before leaving`);

      await press(chrome, "document.querySelector('[data-tab=items]')");
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && !document.querySelector('[data-pane=items]').hidden");
      const refreshMarkerTitle = `Refresh marker ${width}px`;
      await box.inProcess(repo.repo, 'add', 'web', refreshMarkerTitle, '--specs', 'G1', '--criterion', 'The refresh marker is visible from a real board read.');
      await chrome.waitFor(`data?.project?.items?.some(item => item.title === ${JSON.stringify(refreshMarkerTitle)})`);
      await press(chrome, "document.querySelector('[data-tab=doctrine]')");
      await chrome.waitFor("document.querySelector('[data-tab=doctrine].on') && !document.querySelector('[data-pane=doctrine]').hidden");
      let waitError = null;
      try {
        await chrome.waitFor("!document.querySelector('[data-pane=doctrine]').hidden && document.querySelector('#doctrine-detail h2 span')?.textContent === 'G1' && document.querySelector('#doctrine-detail .links [data-item=\"2\"]')");
      } catch (error) { waitError = error.message; }
      const after = await readDetail();
      assert.equal(after.tab, true, `${width}px: the Doctrine tab is active after returning: ${JSON.stringify(after)}`);
      assert.equal(after.paneHidden, false, `${width}px: the Doctrine pane is visible after returning: ${JSON.stringify(after)}`);
      assert.equal(waitError, null,
        `${width}px: after the tab round trip the selected detail and its item #2 return before the wait expires; ${JSON.stringify({ waitError, after })}`);
      assert.equal(after.targetVisible, true, `${width}px: the returned Doctrine citation is rendered: ${JSON.stringify(after)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

// Hang ceiling: two real boards and six Chrome layouts, each using the shared two-frame stability wait.

/** Check real source metadata and the two-line presentation, including a repo overriding every packaged id. */
test('a doctrine row names its source under its id [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Doctrine source-row checks.');

  const standard = standardDoctrine();
  assert.ok(standard.rows.length >= 3, 'the actual packaged doctrine supplies inherited and override rows');
  const [inherited, overridden, declined] = standard.rows;
  const box = machine();
  const repo = project(box, 'doctrine-source', SPEC, { practice: 'DOCTRINE.md' });
  const longText = 'This repo replaces the standard wording with a deliberately long sentence that must stay complete in the detail and end in an ellipsis in the compact row. '.repeat(4);
  const reason = 'The team declined this inherited rule because the local workflow already covers it.';
  writeFileSync(join(repo.repo, 'DOCTRINE.md'), `# Team doctrine\n\n## Local rules\n`
    + `- ${overridden.id} [approved, must] ${longText} | gate: focused source test | serves: G1\n`
    + `- ${declined.id} [wont] ${reason} | gate: focused source test | serves: G2\n`
    + '- R1 [approved, must] A rule written only for this repository. | gate: local review | serves: G1\n');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-source-chrome-'));
  let chrome;

  /** Read only rendered geometry and labels after the shared two-frame stability wait. */
  const readRow = async (id) => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const row = document.querySelector('#doctrine-list [data-row="doctrine:${id}"]');
    const box = element => { const r = element?.getBoundingClientRect(); return r && { left:r.left, right:r.right, top:r.top, bottom:r.bottom, height:r.height, width:r.width }; };
    const title = row?.querySelector('.t'), meta = row?.querySelector('.meta');
    const source = meta?.querySelector('.rule-source-chip'), gate = meta?.querySelector('.doctrine-check');
    const reason = row?.querySelector('.rule-reason'), idBox = row?.querySelector('.row-id');
    return { text: title?.textContent ?? null, textBox: box(title), textStyle: title && { overflow:getComputedStyle(title).textOverflow, lines:Math.ceil(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) },
      source: source?.textContent ?? null, sourceTitle: source?.title ?? null, sourceBox:box(source), gate:gate?.textContent ?? null, gateBox:box(gate), reason:reason?.textContent ?? null, reasonBox:box(reason), idBox:box(idBox), rowBox:box(row),
      overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));

  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`!!data?.project?.practice?.some(row => row.id === ${JSON.stringify(inherited.id)})`);
    await press(chrome, "document.querySelector('[data-tab=doctrine]')");
    await press(chrome, "document.querySelector('#doctrine-chips [data-rows=\"doctrine:all\"]')");
    const expected = new Map([
      [inherited.id, 'Standard'],
      [overridden.id, 'This repo'],
      [declined.id, 'This repo'],
      ['R1', 'This repo'],
    ]);

    for (const theme of ['light', 'dark']) {
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${theme})').matches`);
        for (const [id, source] of expected) {
          const row = await readRow(id);
          assert.equal(row.source, source, `${width}px ${theme}: ${id} names its actual source under its id`);
          if (id === inherited.id) assert.equal(row.sourceTitle, `Pullboard v${standard.version}`, `${width}px ${theme}: the full packaged version remains on hover`);
          assert.ok(row.rowBox.height >= tapTarget(width), `${width}px ${theme}: ${id} keeps the #371 target size: ${JSON.stringify(row.rowBox)}`);
          assert.ok(row.sourceBox && row.idBox && row.textBox && row.sourceBox.top > row.textBox.top && Math.abs(row.sourceBox.left - row.idBox.left) < 1,
            `${width}px ${theme}: ${id}'s source is visibly beneath the words in the id's content column: ${JSON.stringify(row)}`);
          assert.ok(row.gate && row.gateBox && Math.abs(row.gateBox.top - row.sourceBox.top) < 2 && row.gateBox.left > row.sourceBox.right,
            `${width}px ${theme}: ${id}'s gate follows its source: ${JSON.stringify(row)}`);
          assert.ok(!row.overflow, `${width}px ${theme}: ${id} does not create sideways page scrolling`);
        }
        const override = await readRow(overridden.id);
        assert.ok(override.text.includes('This repo replaces the standard wording'), `${width}px ${theme}: the title retains its words`);
        assert.equal(override.textStyle.overflow, 'ellipsis', `${width}px ${theme}: the first-line title is ellipsized`);
        assert.equal(override.textStyle.lines, 1, `${width}px ${theme}: the title stays on its first line`);
        assert.ok(override.textBox.width > 0, `${width}px ${theme}: the title is rendered`);
        const refused = await readRow(declined.id);
        assert.ok(refused.reason?.includes(reason) && refused.reasonBox && Math.abs(refused.reasonBox.top - refused.sourceBox.top) < 2 && refused.reasonBox.left > refused.sourceBox.right,
          `${width}px ${theme}: the declined rule's reason follows its source: ${JSON.stringify(refused)}`);

        await press(chrome, `document.querySelector('#doctrine-list [data-row="doctrine:${inherited.id}"]')`);
        await chrome.waitFor(`document.querySelector('#doctrine-detail h2 span')?.textContent === ${JSON.stringify(inherited.id)}`);
        const detail = JSON.parse(await chrome.stable(`JSON.stringify(document.querySelector('#doctrine-detail').innerText)`));
        assert.ok(detail.includes(inherited.text) && detail.includes(inherited.gate), `${width}px ${theme}: selecting the row opens its full rule and gate`);
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }

  const allBox = machine();
  const allRepo = project(allBox, 'doctrine-all-overridden', SPEC, { practice: 'DOCTRINE.md' });
  const allStandard = standardDoctrine();
  const rows = allStandard.rows.map((row) => {
    const state = 'approved, must';
    const fields = [row.gate && `gate: ${row.gate}`, row.serves?.length && `serves: ${row.serves.join(', ')}`].filter(Boolean);
    return `- ${row.id} [${state}] Repository wording for ${row.id} is intentionally distinct. ${fields.length ? `| ${fields.join(' | ')}` : ''}`;
  }).join('\n');
  writeFileSync(join(allRepo.repo, 'DOCTRINE.md'), `# All standard rows overridden\n\n## Local rules\n${rows}\n`);
  const allView = await startView(allBox);
  const allProfile = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-all-overridden-chrome-'));
  let allChrome;
  try {
    allChrome = await openSnapshotChrome(executable, allView.link.href, allProfile);
    await allChrome.waitFor(`data?.project?.practice?.length === ${allStandard.rows.length}`);
    await press(allChrome, "document.querySelector('[data-tab=doctrine]')");
    await press(allChrome, "document.querySelector('#doctrine-chips [data-rows=\"doctrine:all\"]')");
    for (const [width, theme] of [[375, 'light'], [1280, 'dark']]) {
      await allChrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await allChrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await allChrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${theme})').matches`);
      const sources = await allChrome.stable(`JSON.stringify([...document.querySelectorAll('#doctrine-list .srow')].map(row => [row.dataset.row, row.querySelector('.meta .rule-source-chip')?.textContent ?? null, row.querySelector('.meta .rule-source-chip')?.title ?? null]))`);
      assert.deepEqual(JSON.parse(sources), allStandard.rows.map((row) => [`doctrine:${row.id}`, 'This repo', `Pullboard v${allStandard.version}, overridden here`]),
        `${width}px ${theme}: every actual standard rule is shown as repository-owned after an override, not inferred from an id pattern`);
      const overflow = await allChrome.stable('document.documentElement.scrollWidth > document.documentElement.clientWidth');
      assert.equal(overflow, false, `${width}px ${theme}: the complete overridden doctrine fits without sideways scrolling`);
    }
  } finally {
    if (allChrome) await closeSnapshotChrome(allChrome);
    rmSync(allProfile, { recursive: true, force: true });
    await allView.stop();
  }
});

test('doctrine rows use the Spec state circle and the plain tier pill, the same pill Spec uses [D3,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Keep evidence. | gate: review\n- R2 [draft, aim] Draft the habit. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 1440 });
    await page.click({ tab: 'doctrine' });
    const list = page.show('doctrine-list');
    /** One rendered row's markup, found by its row id. */
    const rowOf = (html, kind, id) => html.split('<div class="srow').slice(1).find((chunk) => chunk.includes('data-row="' + kind + ':' + id + '"'));
    const approved = rowOf(list, 'doctrine', 'R1'), draft = rowOf(list, 'doctrine', 'R2'), review = rowOf(list, 'doctrine', 'PB7');
    assert.match(approved, /class="dot verified"[^>]*>✓</, 'an approved rule shows the green check circle');
    assert.match(draft, /class="dot open"[^>]*>✎</, 'a draft rule shows the amber pencil circle');
    assert.match(review, /class="dot warn"[^>]*><svg class="doctrine-eye"/, 'a standard rule to review shows the eye circle');
    assert.match(approved, /<div class="spec-row-side"><span class="chip tier-pill tier-must">must<\/span>/, 'the tier is the plain pill on the right');
    assert.match(draft, /<span class="chip tier-pill tier-aim">aim<\/span>/);
    assert.doesNotMatch(approved + draft, /<span class="chip (?:ok|no|warn|)[^"]*">(?:approved|draft)<\/span>/, 'approved and draft status chips are gone from rows');
    assert.match(review, /<span class="chip warn tier-pill doctrine-review-chip">To review<\/span>/, 'a rule waiting for the person reads To review in the same pill shape');
    await page.click({ tab: 'spec' });
    await page.click({ rows: 'spec:all' });
    const specRow = page.show('spec-list');
    const specPill = /<span class="chip (tier-pill tier-(?:must|aim))">/.exec(specRow)?.[1]?.replace(/aim/, 'must');
    assert.equal(specPill, 'tier-pill tier-must', 'Spec rows carry the same tier pill class as Doctrine');
    const style = await styleOf(view);
    assert.match(style, /\.chip\.tier-pill \{[^}]*border-radius: var\(--radius-pill\)[^}]*font: 600 var\(--text-xs\)\/var\(--leading-body\) var\(--sans\)/, 'the shared pill is rounded sans text, not boxed mono');
    assert.match(style, /:is\(#spec-list, #doctrine-list\) \.spec-record > \.dot \{[^}]*width: var\(--space-6\)/, 'Doctrine rows take the Spec state circle');
  } finally {
    await view.stop();
  }
});
