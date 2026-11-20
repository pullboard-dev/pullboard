// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shared items-row check, split from cockpit.test.js [N26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardDoctrine } from '../../../../../packages/doctrine/index.js';
import {
  tapTarget,
  machine,
  project,
  buildLocal,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { fixtureSettledMachine } from '../../../tests/fixtures/testkit.js';
import { pressTab } from '../../../tests/fixtures/cockpit/stable.js';
import { watchSpecFilter } from '../../../tests/fixtures/cockpit/spec-watch.js';

// Hang ceiling: four three-tab layouts, native input and real Git/SQLite setup; two 120s journey budgets plus setup headroom.

/** Compare real Items, Spec and Doctrine rendering and native selection across four viewport/theme layouts. Doctrine records take the Spec record grid (landed in 6e59717725 and cead5a98d7), so their geometry is compared to the Spec row; the font stays on the Items row. */
test('cli.journeys-spec-cockpit-shared.doctrine-and-spec-rows-share-the: clause 1: doctrine and spec rows share the items row [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for shared-row checks.');
  let phaseMark = performance.now();
  const phase = (name) => { const now = performance.now(); console.log(`# phase ${name} ${Math.round(now - phaseMark)}`); phaseMark = now; };

  const standard = standardDoctrine();
  const [inherited, overridden, declined] = standard.rows;
  const longGoal = 'A deliberately long requirement keeps all its words in the detail while the shared row cuts its title with an ellipsis. '.repeat(3);
  const longOverride = 'This repository replaces the standard wording with a long rule that must ellipsize in the shared row while remaining complete in the detail. '.repeat(3);
  const spec = '# Shared rows\n\n## G · Goals\n'
    + `- G1 [draft, must] ${longGoal} | gate: browser check | serves: G3\n`
    + '- G2 [pending, aim] A second undecided row keeps the section approval count honest. | gate: browser check\n'
    + '- G3 [approved, must] Approved text remains available in its detail. | gate: browser check\n';
  const box = machine();
  const demo = project(box, 'shared-rows', spec, { practice: 'DOCTRINE.md' });
  const reason = 'The local process already covers this inherited rule.';
  writeFileSync(join(demo.repo, 'DOCTRINE.md'), `# Team doctrine\n\n## Rules\n`
    + `- ${overridden.id} [draft, must] ${longOverride} | gate: doctrine check | serves: ${inherited.id}\n`
    + `- ${declined.id} [wont] ${reason} | gate: doctrine check | serves: ${inherited.id}\n`
    + '\n## Local\n- R1 [approved, must] The repository’s own rule stays in its source section. | gate: local check\n- G1 [approved, must] This doctrine rule shares the citing item. | gate: citation check\n');
  await box.runIn(demo.repo, 'add', 'web', 'A real item citing G1', '--specs', 'G1', '--criterion', 'The requirement is represented by a built item.');
  // The claim and submit run in this process and the commit's hooks too; Chrome below is the subject, not the CLI start-up [C7].
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  await buildLocal(box, demo, 1, 'shared-row.txt');
  phase('setup and board seeding');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shared-rows-chrome-'));
  let chrome;
  let filterTrace;
  /** Save a full-page proof of the actual rendered tab when a proof folder is requested. */
  const shot = async (kind, width, theme) => {
    if (!process.env.PULLBOARD_ROWS_PROOF) return;
    mkdirSync(process.env.PULLBOARD_ROWS_PROOF, { recursive: true });
    await chrome.stable('window.scrollTo(0, 0)');
    const cssContentSize = JSON.parse(await chrome.stable('JSON.stringify({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})'));
    const capture = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
    writeFileSync(join(process.env.PULLBOARD_ROWS_PROOF, kind + '-' + width + '-' + theme + '.png'), Buffer.from(capture.data, 'base64'));
  };
  /** Capture rendered row geometry and computed row/title type from the live DOM. */
  const rowState = async (selector) => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const box = e => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    const style = e => { if (!e) return null; const s=getComputedStyle(e); return {display:s.display,dotColumn:s.gridTemplateColumns.split(" ")[0],gridTemplateAreas:s.gridTemplateAreas,columnGap:s.columnGap,rowGap:s.rowGap,padding:s.padding,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight}; };
    const title = row?.querySelector('.t'), meta = row?.querySelector('.meta'), source = row?.querySelector('.rule-source, .rule-source-chip'), reason = row?.querySelector('.rule-reason');
    const specRow = row?.classList.contains('spec-record');
    const age = row?.querySelector(specRow ? '.spec-row-side small' : '.row-age');
    const trace = window.__specFilterTrace;
    const currentRow = document.querySelector('#spec-list [data-row="spec:G1"]');
    return {tag:row?.tagName ?? null, className:row?.className ?? '', title:title?.textContent ?? '', titleFull:row?.getAttribute('title') ?? '', titleBox:box(title), titleStyle:title&&{overflow:getComputedStyle(title).textOverflow,whiteSpace:getComputedStyle(title).whiteSpace,lines:Math.ceil(title.getBoundingClientRect().height/parseFloat(getComputedStyle(title).lineHeight))},
      rowBox:box(row), rowStyle:style(row), dot:!!row?.querySelector(':scope > .dot'), meta:meta?.textContent ?? '', metaBox:box(source), source:source?.textContent ?? null, sourceTitle:source?.title ?? null, sourceBox:box(source), reason:reason?.textContent ?? null, reasonBox:box(reason), gate:row?.querySelector('.meta .gate, .meta .doctrine-check')?.textContent ?? null, gateBox:box(row?.querySelector('.meta .gate, .meta .doctrine-check')),
      count:age?.textContent.trim() ?? null, countBox:box(age), status:row?.querySelector(specRow ? '.spec-row-side .chip' : ':scope > .chip')?.textContent.trim() ?? null, statusBox:box(row?.querySelector(specRow ? '.spec-row-side .chip' : ':scope > .chip')), stateIcon:row?.querySelector(':scope > .dot')?.textContent ?? '',
      renderProvenance:trace ? { readAt:performance.now(), currentFilter:typeof view === 'object' ? view.rows?.spec ?? null : null,
        sourceDataStatus:typeof data === 'object' ? data.project?.spec?.find(entry => entry.id === 'G1')?.status ?? null : null,
        events:trace.events.slice(-8), attempts:trace.attempts.slice(-8), renders:trace.renders.slice(-8),
        renderAttemptCount:trace.renderAttemptCount, renderCount:trace.renderCount,
        lastRenderId:trace.lastRenderId, currentRowRenderId:currentRow === trace.lastRow ? trace.lastRenderId : null,
        currentRowIsLastRendered:currentRow === trace.lastRow, captureErrors:trace.captureErrors.slice(-4) } : null,
      overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth, pageWidth:document.documentElement.clientWidth, pageScrollWidth:document.documentElement.scrollWidth};
  })())`));

  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.spec?.some(row => row.id === 'G1') && data?.project?.practice?.some(row => row.id === 'R1')");
    phase('Chrome start');
    for (const theme of ['light', 'dark']) {
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${theme})').matches`);
        await pressTab(chrome, 'items');
        const item = await rowState('#chain .row[data-item="1"]');
        assert.ok(item?.dot, `${width}px ${theme}: the Items reference row has its status dot`);
        assert.equal(item.overflow, false, `${width}px ${theme}: the Items row has no horizontal overflow`);

        await pressTab(chrome, 'spec');
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
        const g1 = await rowState('#spec-list [data-row="spec:G1"]');
        const g2 = await rowState('#spec-list [data-row="spec:G2"]');
        assert.match(g1.className, /(?:^|\s)srow(?:\s|$)/u);
        assert.match(g1.className, /(?:^|\s)row(?:\s|$)/u, `${width}px ${theme}: Spec uses the shared Items row component`);
        assert.equal(g1.dot, true);
        assert.equal(g1.overflow, false, `${width}px ${theme}: Spec has no horizontal overflow`);
        assert.equal(g1.count, '1 item', `${width}px ${theme}: G1 shows its exact citation count below the tier`);
        assert.ok(g1.countBox.y >= g1.statusBox.bottom && Math.abs(g1.countBox.right - g1.statusBox.right) < 2, `${width}px ${theme}: the citation count is right-aligned below the tier`);
        assert.equal(g1.status, 'must', `${width}px ${theme}: All rows keeps the tier in its slot`);
        assert.equal(g1.stateIcon, '✎', `${width}px ${theme}: the state circle identifies a draft`);
        assert.equal(g2.count, '0 items', `${width}px ${theme}: an uncited Spec row has an explicit citation count`);
        assert.equal(g2.status, 'aim', `${width}px ${theme}: a pending question retains its declared aim tier`);
        assert.equal(g1.rowStyle.gridTemplateAreas, '"dot main side"', `${width}px ${theme}: Spec uses the approved state, text and side-column grid`);
        assert.equal(g1.rowStyle.fontFamily, item.rowStyle.fontFamily, `${width}px ${theme}: Spec retains the shared row font`);
        assert.equal(g1.titleStyle.overflow, 'ellipsis');
        assert.equal(g1.titleStyle.whiteSpace, 'nowrap');
        assert.equal(g1.titleStyle.lines, 1);
        assert.ok(g1.titleFull.includes(longGoal.slice(0, 40)), `${width}px ${theme}: the full title remains available on the row`);

        const header = JSON.parse(await chrome.stable(`JSON.stringify((() => { const e=document.querySelector('#spec-list .spec-section-head'); return {text:e?.innerText??'', count:e?.querySelector('.section-count')?.textContent.trim()??null, approve:e?.querySelector('[data-section-approve]')?.innerText??null}; })())`));
        assert.match(header.text, /Goals/u);
        assert.equal(header.count, '3', `${width}px ${theme}: the section header shows its three rows`);
        assert.equal(header.approve, null, `${width}px ${theme}: Spec group headers carry no Approve all`);

        filterTrace = await watchSpecFilter(chrome);
        let assertionError;
        try {
          await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')");
          const draft = await rowState('#spec-list [data-row="spec:G1"]');
          const pending = await rowState('#spec-list [data-row="spec:G2"]');
          const capture = JSON.stringify({ row: draft, currentFilter: draft.renderProvenance?.currentFilter,
            sourceDataStatus: draft.renderProvenance?.sourceDataStatus, rowStatus: draft.status,
            renderAttemptCount: draft.renderProvenance?.renderAttemptCount, renderCount: draft.renderProvenance?.renderCount,
            currentRowRenderId: draft.renderProvenance?.currentRowRenderId,
            events: draft.renderProvenance?.events, attempts: draft.renderProvenance?.attempts, renders: draft.renderProvenance?.renders,
            captureErrors: draft.renderProvenance?.captureErrors });
          assert.equal(draft.status, 'must', `${width}px ${theme}: the filter-implied draft status gives way to its tier; row/render capture ${capture}; ROOT-CAUSE STATUS: NOT PROVEN`);
          assert.equal(pending.status, 'aim', `${width}px ${theme}: the pending question keeps its declared tier; row/render capture ${JSON.stringify({ row: pending, rootCauseStatus: 'NOT PROVEN' })}; ROOT-CAUSE STATUS: NOT PROVEN`);
        } catch (error) {
          assertionError = error;
          throw error;
        } finally {
          const disposeError = await filterTrace.dispose();
          if (disposeError) {
            if (assertionError) assertionError.message += `; filter-observer cleanup also failed: ${disposeError}`;
            else throw new Error(`filter-observer cleanup failed: ${disposeError}`);
          }
          filterTrace = null;
        }
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:approved\"]')");
        const approved = await rowState('#spec-list [data-row="spec:G3"]');
        assert.equal(approved.status, 'must', `${width}px ${theme}: an approved requirement keeps its tier`);
        assert.equal(approved.stateIcon, '✓', `${width}px ${theme}: the state circle identifies approval`);
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
        await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
        await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G1'");
        let detail = await chrome.stable("document.querySelector('#spec-detail').innerText");
        assert.ok(detail.includes(longGoal.trim()) && detail.includes('browser check') && detail.includes('G3') && detail.includes('#1 A real item citing G1'), `${width}px ${theme}: clicking Spec opens full text, gate, served area and citing item`);
        let actions = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#spec-detail [data-row-decision]')].map(e=>({action:e.dataset.rowDecision,text:e.innerText,key:e.querySelector('kbd')?.innerText??null,height:e.getBoundingClientRect().height,background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth})))`));
        assert.deepEqual(actions.map(e=>e.action), ['approve','decline']);
        assert.equal(actions[0].key, 'A'); assert.equal(actions[1].key, 'D');
        assert.notEqual(actions[0].background, 'rgba(0, 0, 0, 0)', 'Approve is filled');
        assert.equal(actions[1].background, 'rgba(0, 0, 0, 0)', 'Decline is outlined');
        assert.ok(actions.every(e=>e.height >= tapTarget(width) && e.border === '1px'), `${width}px ${theme}: detail actions meet #371 targets`);

        await shot('spec', width, theme);
        await pressTab(chrome, 'doctrine');
        await press(chrome, "document.querySelector('#doctrine-chips [data-rows=\"doctrine:all\"]')");
        const pb1 = await rowState(`#doctrine-list [data-row="doctrine:${inherited.id}"]`);
        const pb2 = await rowState(`#doctrine-list [data-row="doctrine:${overridden.id}"]`);
        const pb3 = await rowState(`#doctrine-list [data-row="doctrine:${declined.id}"]`);
        const local = await rowState('#doctrine-list [data-row="doctrine:R1"]');
        assert.equal(pb1.source, 'Standard', `${width}px ${theme}: an inherited row uses the concise Standard chip`);
        assert.equal(pb1.sourceTitle, `Pullboard v${standard.version}`, `${width}px ${theme}: its packaged version stays available on hover`);
        assert.equal(pb2.source, 'This repo');
        assert.equal(pb3.source, 'This repo');
        assert.equal(local.source, 'This repo');
        for (const row of [pb1,pb2,pb3,local]) {
          assert.match(row.className, /(?:^|\s)srow(?:\s|$)/u);
          assert.match(row.className, /(?:^|\s)row(?:\s|$)/u);
          assert.deepEqual(row.rowStyle, g1.rowStyle, `${width}px ${theme}: every doctrine record shares the Spec record geometry and type`);
          assert.equal(row.rowStyle.fontFamily, item.rowStyle.fontFamily, `${width}px ${theme}: and the Items row font`);
          assert.ok(row.dot && !row.count && !row.overflow, `${width}px ${theme}: uncited rules have a dot, no zero-count marker, and no horizontal overflow`);
        }
        assert.ok(pb2.sourceBox.y > pb2.titleBox.y && Math.abs(pb2.sourceBox.x - pb2.titleBox.x) < 1);
        assert.ok(Math.abs(pb2.sourceBox.y - pb2.gateBox.y) < 2, `${width}px ${theme}: source and gate share the second line`);
        assert.ok(pb3.reason && Math.abs(pb3.reasonBox.y - pb3.sourceBox.y) < 2 && pb3.reasonBox.x > pb3.sourceBox.x, `${width}px ${theme}: a declined reason follows its source on the metadata line`);
        assert.equal(pb2.titleStyle.overflow, 'ellipsis');
        assert.equal(pb2.titleStyle.lines, 1);
        assert.ok(pb2.titleBox.width > 0, `${width}px ${theme}: the full-width detail rule still has a visible title line`);
        const sectionCounts = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#doctrine-list .spec-section-head')].map(e=>({name:e.querySelector('h3')?.innerText??'', count:e.querySelector('.section-count')?.textContent.trim()??null, review:e.querySelector('.doctrine-review-count')?.textContent??null})))`));
        assert.ok(sectionCounts.some(e => e.name.startsWith('PB · Pullboard rules') && e.count === String(standard.rows.length - 2) && e.review === '1 to review'), `${width}px ${theme}: the inherited section excludes the two repository overrides and counts its one awaiting review`);
        assert.equal(sectionCounts.reduce((n, e) => n + Number(e.count), 0), standard.rows.length + 2, `${width}px ${theme}: separated source sections retain every merged rule exactly once`);
        assert.ok(sectionCounts.some(e => e.count === '2'), `${width}px ${theme}: the repo-only section keeps its own row count`);
        const citedRule = await rowState('#doctrine-list [data-row="doctrine:G1"]');
        assert.equal(citedRule.count, '1 item', `${width}px ${theme}: Doctrine counts its actual citing item on line one`);
        await press(chrome, "document.querySelector('#doctrine-list [data-row=\"doctrine:G1\"]')");
        const citedDetail = await chrome.stable("document.querySelector('#doctrine-detail').innerText");
        assert.ok(citedDetail.includes('This doctrine rule shares the citing item.') && citedDetail.includes('Checked in review') && citedDetail.includes('#1 A real item citing G1'), `${width}px ${theme}: Doctrine detail lists the actual item that cites it`);
        const allText = await chrome.stable('document.body.innerText.toLowerCase()');
        assert.equal(allText.includes('standard 1'), false, `${width}px ${theme}: the old label is absent`);

        await press(chrome, `document.querySelector('#doctrine-list [data-row="doctrine:${overridden.id}"]')`);
        await chrome.waitFor(`document.querySelector('#doctrine-detail h2 span')?.textContent === ${JSON.stringify(overridden.id)}`);
        await chrome.stable('window.scrollTo(0, 0)');
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
        const visibleDetail = JSON.parse(await chrome.stable("JSON.stringify((() => {const r=document.querySelector('#doctrine-detail h2').getBoundingClientRect(); return {top:r.top,bottom:r.bottom};})())"));
        assert.ok(visibleDetail.top >= -1 && visibleDetail.top < 900, `${width}px ${theme}: native Enter opens the picked detail in the viewport: ${JSON.stringify(visibleDetail)}`);
        detail = await chrome.stable("document.querySelector('#doctrine-detail').innerText");
        assert.ok(detail.includes(longOverride.trim()) && detail.includes('Checked in review') && detail.includes(inherited.id) && detail.includes('Cited by') && detail.includes('No items yet'), `${width}px ${theme}: Enter on the picked rule opens full detail: ${detail}`);
        assert.ok(!await chrome.stable('document.documentElement.scrollWidth > document.documentElement.clientWidth'), `${width}px ${theme}: no horizontal overflow`);
        await shot('doctrine', width, theme);
        phase(`layout ${theme} ${width}`);
      }
    }
    // The same wide layout becomes touch-sized when its primary pointer is coarse.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
    for (const kind of ['spec', 'doctrine']) {
      await pressTab(chrome, `${kind}`);
      await press(chrome, `document.querySelector('#${kind}-chips [data-rows="${kind}:all"]')`);
      const id = kind === 'spec' ? 'G1' : overridden.id;
      await press(chrome, `document.querySelector('#${kind}-list [data-row="${kind}:${id}"]')`);
      const targets = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const nodes = [...document.querySelectorAll('#${kind}-list [data-row], #${kind}-list [data-section-approve], #${kind}-detail [data-row-decision]')];
        return {coarse:matchMedia('(pointer: coarse)').matches, tap:getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),
          heights:nodes.map(node => ({name:node.dataset.row || node.textContent.trim(), height:node.getBoundingClientRect().height}))};
      })())`));
      assert.equal(targets.coarse, true, kind + ': the real wide Chrome viewport has a coarse primary pointer');
      assert.equal(targets.tap, '44px', kind + ': touch uses the accepted 44px sizing token');
      assert.ok(targets.heights.length > 2 && targets.heights.every(target => target.height >= 44), kind + ': rows and both detail decisions meet the touch target: ' + JSON.stringify(targets));
    }
    phase('coarse-pointer pass');
  } finally {
    try { await filterTrace?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        rmSync(profile, { recursive: true, force: true });
        await view.stop();
      }
    }
  }
});
