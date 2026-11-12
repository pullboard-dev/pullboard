// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (pipeline), using the shared real-board fixtures [N26]. */
import '../../init/geometry.test.js';
import {
  submitFixture,
} from '../../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  addItem,
} from '../../../../../packages/store/index.js';
import {
  machine,
  project,
  startView,
  target,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  settled,
  earlier,
  press,
  travel,
} from '../../../tests/fixtures/cockpit/harness.js';

/** Native lifecycle writers on a private clock give each pipeline stage a known arrival. */
function pipelineBoard(box, alpha) {
  const base = Date.now() - 60 * 60_000, commit = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}'), digest = 'a'.repeat(64);
  const at = (minute, move) => earlier(alpha.repo, base + minute * 60_000, move);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'pipeline-reviewer') }));
  for (const [id, minute] of [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 2]]) at(minute, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Pipeline item ' + id + (id === 6 ? ' ' + 'Averylongword'.repeat(35) : ''), specIds: ['G1'], criterion: 'Shows the stage' }));
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  const submit = (id, minute) => at(minute, board => submitFixture(board, id, { agentId: 'web-1', commit, tree }));
  const acceptAt = (id, minute) => at(minute, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private pipeline fixture', head: commit, digest, policy: 'any' }));
  claim(1, 3); submit(1, 4); acceptAt(1, 5);
  at(6, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  claim(2, 7); submit(2, 8); acceptAt(2, 9);
  claim(3, 10); submit(3, 11); claim(4, 12); claim(4, 20);
  at(20, board => store.editItem(board, 5, { agentId: 'coordinator', brief: 'Edited after the newer open item was added' }));
  return { base, arrivals: { open: [5, 0], claimed: [4, 12], submitted: [3, 11], accepted: [2, 9], merged: [1, 6] } };
}

/** Installs capture diagnostics for real Pipeline card presses and leaves the original timeout error intact. */
async function installPipelinePressDiagnostics(chrome) {
  const setup = await chrome.stable(`(() => {
    const pipeline = document.querySelector('#pipeline');
    if (!pipeline) throw new Error('Pipeline container is missing');
    const state = { armed: false, redraws: 0, redrawsAtArm: 0, expected: null, down: null, up: null, click: null };
    const observer = new MutationObserver(records => { state.redraws += records.filter(record => record.target === pipeline && record.type === 'childList').length; });
    observer.observe(pipeline, { childList: true });
    const flush = () => { state.redraws += observer.takeRecords().filter(record => record.target === pipeline && record.type === 'childList').length; return state.redraws; };
    const describe = node => node instanceof Element ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : String(node);
    const listen = kind => event => {
      if (!state.armed) return;
      const card = event.composedPath().find(node => node instanceof Element && node.classList.contains('pipeline-item')) ?? null;
      state[kind] = { target: describe(event.target), dataItem: card?.dataset.item ?? null, connected: card?.isConnected ?? false,
        viewItem: view.item, pathname: location.pathname, innerWidth, redraws: flush(), node: card };
      if (kind === 'up' && state.down) state.down.connectedAtUp = Boolean(state.down.node?.isConnected);
      if (kind === 'click' && state.down) state.click.sameNodeAsDown = state.click.node === state.down.node;
    };
    document.addEventListener('mousedown', listen('down'), true);
    document.addEventListener('mouseup', listen('up'), true);
    document.addEventListener('click', listen('click'), true);
    state.arm = card => { flush(); state.expected = { dataItem: card?.dataset.item ?? null, connected: Boolean(card?.isConnected), disabled: card?.disabled ?? null };
      state.expectedNode = card; state.down = state.up = state.click = null; state.redrawsAtArm = state.redraws; state.armed = true; return state.expected; };
    state.snapshot = () => {
      const redraws = flush();
      const clean = event => event && ({ target: event.target, dataItem: event.dataItem, connected: event.connected, connectedAtUp: event.connectedAtUp,
        disabled: event.disabled, viewItem: event.viewItem, pathname: event.pathname, innerWidth: event.innerWidth, redraws: event.redraws,
        sameNodeAsDown: event.sameNodeAsDown });
      return { expected: state.expected, down: clean(state.down), up: clean(state.up), click: clean(state.click), refresh: state.refresh ?? null, expectedNodeConnected: Boolean(state.expectedNode?.isConnected),
        downNodeConnectedNow: Boolean(state.down?.node?.isConnected), viewItem: view.item, pathname: location.pathname, innerWidth,
        // press() scrolls and settles the target after arm(); those redraws precede the native press.
        pipelineRedrawsBeforeDown: state.down ? state.down.redraws - state.redrawsAtArm : null,
        pipelineRedrawsSinceDown: state.down ? redraws - state.down.redraws : null,
        pipelineRedrawsBetweenDownAndUp: state.down && state.up ? state.up.redraws - state.down.redraws : null };
    };
    globalThis.__pipelinePressDiagnostic = state;
    return { ready: true, pathname: location.pathname, selected: view.item };
  })()`);
  assert.equal(setup.ready, true, 'the real Pipeline diagnostics are installed');
}

/** Waits for the original Pipeline selection predicate and adds real press diagnostics if its wait times out. */
async function waitForPipelineItem(chrome, id) {
  try {
    await chrome.waitFor(`view.item === ${id}`);
  } catch (error) {
    let snapshot = 'diagnostics unavailable';
    try { snapshot = await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic?.snapshot() ?? null)'); } catch { /* diagnostics are best-effort; the original wait error is rethrown below */ }
    error.message += `; Pipeline press diagnostics for #${id}: ${snapshot}`;
    throw error;
  }
}

test('Pipeline view shows every stage, status counts, stage ages, detail links and its phone address [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Pipeline view criterion');
  const box = machine(), alpha = project(box, 'pipeline-board');
  const { base, arrivals } = pipelineBoard(box, alpha);
  const status = JSON.parse(await box.inProcess(alpha.repo, 'status', '--json')).stats.items;
  assert.deepEqual(status, { open: 2, claimed: 1, submitted: 1, verified: 2, withdrawn: 0 });
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    const listRead = "JSON.stringify([...document.querySelectorAll('#chain > li[data-item]')].map(row => ({id:Number(row.dataset.item),title:row.title,meta:row.querySelector('.meta').textContent,tag:row.lastElementChild.textContent})))";
    const listBefore = await chrome.stable(listRead);
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    assert.equal(await chrome.stable('location.pathname'), '/items/pipeline', 'Pipeline has its own shareable address');
    await chrome.waitFor("typeof data !== 'undefined' && location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    const expectedCounts = [0, status.open, status.claimed, status.submitted, 1, 0, 1];
    const read = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#pipeline [data-pipeline-stage]')].map(stage => ({ stage:stage.dataset.pipelineStage, label:stage.querySelector('h2').textContent, count:Number(stage.querySelector('[data-stage-count]').textContent), oldest:Number(stage.querySelector('.pipeline-oldest a[data-go]')?.dataset.go.slice('item:'.length) || 0), since:stage.querySelector('.pipeline-oldest time')?.dataset.ago || null, age:stage.querySelector('.pipeline-oldest time')?.textContent || '', ids:[...stage.querySelectorAll('.pipeline-item')].map(item => Number(item.dataset.item)) })))`));
    assert.deepEqual(read.map(stage => stage.label), ['Gated', 'Ready', 'Building', 'In review', 'Verified', 'Landing', 'Merged']);
    assert.deepEqual(read.map(stage => stage.count), expectedCounts, 'the seven ordered stage columns preserve the native status counts');
    assert.equal(read[4].count + read[6].count, status.verified);
    assert.deepEqual(read.map(stage => stage.ids), [[], [5, 6], [4], [3], [2], [], [1]], 'an accept without a merge remains verified');
    const observedAt = await chrome.stable('Date.now()');
    for (const stage of read) {
      const arrivalKey = { ready: 'open', building: 'claimed', 'in-review': 'submitted', verified: 'accepted' }[stage.stage] || stage.stage;
      if (!stage.ids.length) { assert.equal(stage.oldest, 0, stage.stage + ': empty stage has no oldest item'); continue; }
      const [id, minute] = arrivals[arrivalKey], since = new Date(base + minute * 60_000).toISOString();
      assert.equal(stage.oldest, id, stage.stage + ': oldest item');
      assert.equal(stage.since, since, stage.stage + ': stage arrival survives edit or lease renewal');
      assert.ok(stage.age.length > 0, stage.stage + ': visible elapsed age');
      assert.match(stage.age, /^\d+(m|h)$/, stage.stage + ': a visible elapsed time');
      const elapsed = parseInt(stage.age, 10) * (stage.age.endsWith('h') ? 60 : 1);
      assert.ok(Math.abs(elapsed - (observedAt - Date.parse(since)) / 60_000) <= 1, stage.stage + ': elapsed time matches native fixture arrival'); // budget: one minute is the display's measured-age rounding unit.
    }
    assert.equal(await chrome.stable("document.querySelector('#item-list').hidden"), true);
    await installPipelinePressDiagnostics(chrome);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:scheme}] });
      await chrome.stable('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()');
      assert.equal(await chrome.stable('document.documentElement.dataset.scheme'), scheme);
      for (const id of [1, 2, 3, 4, 5, 6]) {
        const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
        await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
        await press(chrome, selector);
        await waitForPipelineItem(chrome, id); // budget: hang-only ceiling for the opened Pipeline item; no speed target.
        assert.equal(await chrome.stable('view.item'), id, `${width}: every item opens its detail`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
      }
      const geometry = JSON.parse(await chrome.stable("JSON.stringify({ width:innerWidth, body:document.documentElement.scrollWidth, stages:[...document.querySelectorAll('.pipeline-stage')].map(node => ({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})) })"));
      assert.ok(geometry.body <= width, `${width}: no sideways scroll: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.stages.every(stage => stage.left >= 0 && stage.right <= width), `${width}: the flow fits the screen`);
      if (process.env.PULLBOARD_PIPELINE_SHOTS) {
        mkdirSync(process.env.PULLBOARD_PIPELINE_SHOTS, {recursive:true});
        await chrome.stable('scrollTo(0,0)');
        const shot = await chrome.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
        writeFileSync(join(process.env.PULLBOARD_PIPELINE_SHOTS, `pipeline-${width}-${scheme}.png`), Buffer.from(shot.data,'base64'));
      }
      }
    }
    await box.inProcess(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await chrome.waitFor("document.querySelector('[data-stage-count=verified]').textContent === '0' && document.querySelector('[data-stage-count=merged]').textContent === '2'");
    assert.equal(await chrome.stable("document.querySelector('#pipeline [data-pipeline-stage=verified] .pipeline-oldest').textContent"), 'No items', 'a recorded merge advances only the verified item and leaves an honest empty stage');
    await press(chrome, "document.querySelector('[data-items-view=\"list\"]')");
    await chrome.waitFor("!location.hash && !document.querySelector('#item-list').hidden && document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.stable(listRead), listBefore, 'returning to List preserves its Active rows, metadata and ordering');
    assert.deepEqual(JSON.parse(listBefore).map(row => row.id).sort((a,b)=>a-b), [3,4,5,6]);
    await travel(chrome, -1);
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && data?.project && !document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.stable("document.querySelector('.tab.on').dataset.tab"), 'items', 'the Pipeline address reloads within Items');
    await travel(chrome, 1);
    await settled(chrome, "!location.hash && !document.querySelector('#item-list').hidden");
    assert.deepEqual(chrome.exceptions, [], 'the pipeline has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A real card press records click delivery, Pipeline redraws and address selection under CPU throttling [N26,N38,C7]. */
test('the pipeline opens the clicked item under a 6× CPU throttle [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one browser journey at the declared 6× CPU load.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled Pipeline click diagnostic');
  const box = machine(), alpha = project(box, 'pipeline-click-under-load');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-click-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    const id = 2;
    const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
    const armed = await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
    assert.deepEqual(armed, { dataItem: String(id), connected: true, disabled: false }, 'the intended real card is present and enabled before press');
    let failure = null;
    try {
      await press(chrome, selector);
      await chrome.waitFor(`(() => { const evidence = globalThis.__pipelinePressDiagnostic.snapshot(); globalThis.__pipelinePressDiagnostic.last = evidence; return evidence.viewItem === ${id}; })()`, 15_000); // budget: hang ceiling for the clicked item to reach its detail, not a speed target.
    } catch (error) {
      failure = error;
    }
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.last || globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(failure, null, `${failure?.message || 'the selected item matched'}; Pipeline click evidence: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.dataItem, String(id), `the mousedown reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, String(id), `the mouseup remained on the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, String(id), `the real click reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, id, `the intended item is selected: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, `/items/${id}`, `the address names the intended item: ${JSON.stringify(evidence)}`);
    await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
    t.diagnostic(`375px 6× Pipeline click: ${JSON.stringify(evidence)}`);
    assert.deepEqual(chrome.exceptions, [], 'the throttled Pipeline click has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A real API refresh while the pointer is held must leave the pressed Pipeline card for its click. */
test('a refresh between pointer down and up does not lose the click [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one native press and forced local refresh; no speed threshold.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the held-pointer refresh journey');
  const box = machine(), alpha = project(box, 'pipeline-refresh-under-press');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-refresh-press-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(document.querySelector('#pipeline .pipeline-item[data-item="2"]'))`);
    let refreshObservation;
    await press(chrome, "document.querySelector('#pipeline .pipeline-item[data-item=\"2\"]')", {
      afterMouseDown: async () => {
        const title = 'A new item arrives during the held Pipeline press';
        await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Refresh the board while a card is pressed');
        refreshObservation = JSON.parse(await chrome.stable(`(async () => {
          await refresh();
          const old = globalThis.__pipelinePressDiagnostic.down?.node;
          const press = globalThis.__pipelinePressDiagnostic.snapshot();
          const observation = { fetchedNewItem: data.project.items.some(item => item.title === ${JSON.stringify(title)}),
            originalCardConnectedWhileHeld: Boolean(old?.isConnected), selected: view.item, pathname: location.pathname, innerWidth,
            pipelineRedrawsBeforeRelease: press.pipelineRedrawsSinceDown, pipelineRedrawsBeforeDown: press.pipelineRedrawsBeforeDown };
          globalThis.__pipelinePressDiagnostic.refresh = observation;
          return JSON.stringify(observation);
        })()`));
        assert.equal(refreshObservation.fetchedNewItem, true, `the real API refresh received the new native board item: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.originalCardConnectedWhileHeld, true, `the changed board does not replace the pressed card before mouseup: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.pipelineRedrawsBeforeRelease, 0, `the Pipeline has not redrawn while the pointer is held: ${JSON.stringify(refreshObservation)}`);
      },
    });
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(evidence.down?.dataItem, '2', `mousedown reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, '2', `mouseup reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, '2', `the browser dispatched click to the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.connectedAtUp, true, `the original card remained connected through mouseup: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.sameNodeAsDown, true, `the click belongs to the card that received mousedown: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, 2, `the native click opens item #2: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, '/items/2', `the item address agrees with the real selection: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pipelineRedrawsBetweenDownAndUp, 0, `no Pipeline redraw separates mousedown and mouseup: ${JSON.stringify(evidence)}`);
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('#2')");
    await chrome.stable('refresh()');
    assert.equal(await chrome.stable('view.item'), 2, 'refresh preserves the selected item instead of an address candidate');
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/2' && view.item === 2");
    assert.equal(await chrome.stable('view.item'), 2, 'reload restores the selected item from its address');
    t.diagnostic(`375px 6× held-pointer API refresh: ${JSON.stringify({ refreshObservation, evidence })}`);
    assert.deepEqual(chrome.exceptions, [], 'the refresh and held-pointer click produce no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
