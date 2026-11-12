// pullboard: browser
/** @pullboard-test-gui */
/** Dashboard keeps the rules and capacity cards while the Home tab is retired [N26,U91]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchPage,
  machine,
  openPage,
  project,
  startView,
  storage,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  allowLiveHold,
  holdLive,
  press,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { rebuildProofCounters } from '../../../../packages/verify/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

const HOUR = 3_600_000;

/** Two gated rows, one approved aim with no gate, and an open question for the person. */
const SPEC = `# Home spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The page says goodbye. | gate: web test
- G3 [approved, aim] The page reads well.
- G4 [pending, must] Should the page greet a visitor? | gate: review
`;

/** One count from the rules card, by its key. */
function count(html, key) {
  return Number(new RegExp(`data-home-count="${key}"><dt>[^<]+</dt><dd>(\\d+)</dd>`).exec(html)?.[1]);
}

test('Dashboard is the landing page, carries the rules, and migrates saved Home state [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC);
  const view = await startView(box);
  try {
    const html = await (await fetchPage(view)).text();
    const navigation = /<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/u.exec(html)?.[1] ?? '';
    const tabs = [...navigation.matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"[^>]*>/gu)].map(([, tab]) => tab);
    assert.equal(tabs[0], 'dashboard', 'Dashboard is the first tab');
    assert.doesNotMatch(html, /data-tab="home"|data-pane="home"/u, 'the retired Home tab and pane are absent');

    // A new board opens on Dashboard, which retains the rules and the calls waiting on the person.
    const fresh = await openPage(view, { store: storage() });
    assert.equal(fresh.run('view.tab'), 'dashboard', 'a board with no items yet opens on Dashboard');
    assert.match(fresh.show('dashboard'), /data-first-run-tour/, 'a new board first presents the setup tour');
    fresh.run("keep('pb.firstrun.' + view.root, 'hidden'); render();");
    const rules = fresh.show('dashboard');
    assert.deepEqual(['approved', 'gated', 'ungated'].map((key) => count(rules, key)), [3, 2, 1], 'approved rows, those naming a gate, and those with none');
    assert.match(rules, /data-go="tab:spec"/, 'the rules card opens the Spec');
    const dashboard = fresh.show('dashboard');
    assert.match(dashboard, /aria-label="Needs you"[^]*?Should the page greet a visitor\?/u, 'Dashboard keeps the call waiting on the person');
    assert.doesNotMatch(dashboard, /Nothing needs you/u, 'a visible call suppresses the calm state');

    // Existing work also opens on Dashboard; the person's explicit Items choice is remembered.
    box.run(alpha.repo, 'add', 'web', 'Render the page', '--specs', 'G1');
    const store = storage();
    const working = await openPage(view, { store });
    assert.equal(working.run('view.tab'), 'dashboard', 'a board with work opens on Dashboard');
    const savedHome = storage();
    savedHome.setItem('pb.tab', 'home');
    assert.equal((await openPage(view, { store: savedHome })).run('view.tab'), 'dashboard', 'a saved Home tab opens on Dashboard');
    await working.click({ tab: 'items' });
    assert.equal((await openPage(view, { store })).run('view.tab'), 'items', 'Items is one click back, and kept too');
  } finally {
    await view.stop();
  }
});


/** A projected measurement, never a forecast calculated by the browser. */
const CAPACITY = {
  available: true, stale: false, asOf: '2026-10-25T10:00:00Z',
  agents: { recommended: 24, lower: 16, upper: 32 }, finishHours: { lower: 18, upper: 22 },
  binding: { kind: 'rework', text: 'Rework limits useful concurrency.' },
  lever: { text: 'Halve rejects.' }, needsYou: [2, 7], unknown: [],
  curve: [{ agents: 1, hours: 40 }, { agents: 2, hours: 20 }, { agents: 4, hours: 18 }],
  monteCarlo: { asOf: '2026-10-25T10:00:00Z' },
};

test('home renders the projected useful agents range lever and curve and refreshes unavailable state [N26,R1,R2]', async () => {
  const box = machine();
  project(box, 'capacity home', SPEC);
  const view = await startView(box);
  try {
    const page = await openPage(view, { store: storage() });
    assert.match(page.html, /id="dashboard-capacity"/, 'the served page mounts the capacity card on Dashboard');
    page.run("keep('pb.firstrun.' + view.root, 'hidden'); render();");
    page.run(`data.project.capacityForecast = ${JSON.stringify(CAPACITY)}; render();`);
    const html = page.show('dashboard');
    assert.match(html, /Max useful agents now: <strong>24<\/strong> \(16–32\)/);
    assert.match(html, /Finish in about 18–22 h/);
    assert.match(html, /Binding: rework/);
    assert.match(html, /Lever: Halve rejects/);
    assert.match(html, /2 items lack recorded approval evidence/);
    assert.match(html, /<polyline/);
    assert.match(page.show('dashboard'), /Your rules/, 'existing rules remain visible');
    page.run('data.project.capacityForecast = { available: false, stale: true, unknown: ["Missing measured history"] }; render();');
    const unavailable = page.show('dashboard');
    assert.match(unavailable, /Capacity estimate is unavailable/);
    assert.match(unavailable, /Estimates are stale/);
    assert.match(unavailable, /Missing measured history/);
    assert.doesNotMatch(unavailable, /<polyline|<strong>24/, 'old forecast values do not survive the refresh');
  } finally {
    await view.stop();
  }
});


// budget: hang ceiling for one private Chrome session and two viewport observations, not a speed target.
test('Dashboard capacity stays readable at phone and desktop widths in real Chrome [N26,R1,R2]', { timeout: 60_000 }, async t => {
  const executable = chromeExecutable();
  assert.ok(executable, 'this browser-marked check needs an installed Chrome');
  const box = machine();
  project(box, 'capacity chrome', SPEC);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-home-capacity-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile, { signal: t.signal });
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    await holdLive(chrome, "data?.project?.spec.some(row => row.id === 'G1')");
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.waitFor("document.querySelector('#dashboard-capacity') && !document.querySelector('[data-pane=dashboard]').hidden");
    assert.equal(await chrome.stable("Boolean(document.querySelector('#dashboard-capacity'))"), true, 'the real served Dashboard mounts the capacity card');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      // This is a presenter fixture injected into a real page, not a claim of the uncomposed core HTTP integration.
      await chrome.stable(`(() => { data.project.capacityForecast = ${JSON.stringify({ ...CAPACITY, lever: { text: '<img src=x onerror=alert(1)>' } })}; render(); return true; })()`);
      const shown = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const card = document.querySelector('#dashboard-capacity'), rect = card.getBoundingClientRect();
        return { text: card.innerText, curve: Boolean(card.querySelector('polyline')), injected: Boolean(card.querySelector('img,script')),
          left: rect.left, right: rect.right, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: innerWidth };
      })())`));
      assert.match(shown.text, /Max useful agents now: 24.*16–32/s);
      assert.match(shown.text, /Finish in about 18–22 h/);
      assert.match(shown.text, /<img src=x onerror=alert/);
      assert.equal(shown.curve, true);
      assert.equal(shown.injected, false, 'projected labels remain text rather than active markup');
      assert.ok(shown.left >= 0 && shown.right <= width + 1 && shown.page <= width + 1, `capacity layout fits ${width}px: ${JSON.stringify(shown)}`);
      await chrome.stable("(() => { data.project.capacityForecast = { available: false, stale: true, unknown: ['Missing measured history'] }; render(); return true; })()");
      const unknown = await chrome.stable("document.querySelector('#dashboard-capacity').innerText");
      assert.match(unknown, /Capacity estimate is unavailable/);
      assert.match(unknown, /Estimates are stale/);
      assert.doesNotMatch(unknown, /Finish in about/);
    }
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); rmSync(profile, { recursive: true, force: true }); }
  }
});

/** Seed ordinary native board history so the real state endpoint has a measured capacity projection. */
function seedCapacityHistory(box, repo) {
  // @pullboard-board-file journey: the real view server reads this seeded project board over HTTP
  const board = openBoard(join(repo, '.git/pullboard/board.sqlite'));
  const now = Date.now();
  let clock = now - 3 * 24 * HOUR;
  /** Expose the fixture's controlled clock to normal board operations. */
  const capacityNow = () => new Date(clock);
  board.clock = { now: capacityNow };
  try {
    const builder = store.register(board, { lane: 'web', path: join(box.dir, 'capacity-builder'), route: 'strong' });
    const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'capacity-reviewer'), route: 'strong' });
    const adopted = [];
    for (let index = 0; index < 6; index++) {
      clock = now - (60 - index * 4) * HOUR;
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Measured model input ${index}`,
        route: 'strong', brief: `Files: web/history-${index}.js` });
      store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 8 * HOUR,
        freeze: freezeCapacityItem });
      clock += HOUR;
      const commit = String(index + 1).repeat(40);
      submitFixture(board, id, { agentId: builder, commit, tree: commit });
      clock += HOUR / 4;
      store.reserveReview(board, id, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
      clock += HOUR / 2;
      const item = store.getItem(board, id);
      store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit,
        digest: item.item_frozen_digest, note: 'Synthetic model history; no executed gate result is claimed.' });
      clock += HOUR / 4;
      store.merged(board, id, { agentId: 'coordinator', commit });
      adopted.push({ id, commit });
    }
    store.logEvent(board, 'coordinator', 'landing_batch', null, { batch: {
      version: 1, id: 'synthetic-capacity-cycle', state: 'trunk', items: adopted,
      startedAt: new Date(clock - HOUR / 4).toISOString(), updatedAt: new Date(clock).toISOString(),
    } });
    clock = now;
    for (let index = 0; index < 3; index++) store.addItem(board, { by: 'coordinator', lane: 'web',
      title: `Remaining work ${index}`, route: 'strong', brief: `Files: web/remaining-${index}.js` });
    for (const agentId of [builder, reviewer]) store.appendFact(board, adopted[0].id, {
      agentId, kind: 'note', text: 'Synthetic current seat activity for the capacity fixture.',
    });
    rebuildProofCounters(board);
  } finally {
    store.closeBoard(board);
  }
}

/** Format a measured number the same way the Dashboard card presents server-provided values. */
function displayCapacityNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(2))) : 'unknown';
}

/** Freeze synthetic history inputs without implying that their commits ran a real gate. */
function freezeCapacityItem(item) {
  return { text: item.item_title, digest: `synthetic:${item.item_id}` };
}

// budget: one owned Chrome session and two viewport observations; this is a hang ceiling, not a speed target.
/** Render server-measured capacity from the real local API at narrow and desktop viewport sizes. */
test('Dashboard renders the real board capacity at phone and desktop widths [N26,R1,R2]', { timeout: 60_000 }, async t => {
  const executable = chromeExecutable();
  assert.ok(executable, 'this browser-marked check needs an installed Chrome');
  const box = machine();
  const p = project(box, 'capacity-http-chrome', SPEC);
  seedCapacityHistory(box, p.repo);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-home-capacity-http-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile, { signal: t.signal });
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    await holdLive(chrome, 'data?.project?.capacityForecast?.available === true');
    const state = JSON.parse(await chrome.stable('JSON.stringify({ board: data.project.board, capacity: data.project.capacityForecast })'));
    const { board, capacity } = state;
    assert.equal(typeof board, 'string', 'the real state identifies its selected board');
    assert.equal(capacity.available, true, 'the actual board state response carries measured capacity');
    assert.ok(capacity.agents.recommended > 0 && capacity.agents.lower > 0 && capacity.agents.upper >= capacity.agents.lower);
    assert.ok(capacity.finishHours.lower > 0 && capacity.finishHours.upper >= capacity.finishHours.lower);
    assert.ok(capacity.binding.kind && capacity.binding.text && capacity.lever.text);
    let fetchedBoardState = false;
    for (const request of chrome.requests) if (isBoardStateRequest(request, board)) fetchedBoardState = true;
    assert.ok(fetchedBoardState, 'Chrome fetched board state over the real view HTTP route');
    await chrome.waitFor("document.querySelector('#dashboard-capacity') && !document.querySelector('[data-pane=dashboard]').hidden");
    assert.equal(await chrome.stable("Boolean(document.querySelector('#dashboard-capacity'))"), true,
      'the real Dashboard card is mounted without setting data.project.capacityForecast in the page');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 900 });
      await chrome.waitFor(`innerWidth === ${width}`);
      const shown = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const card = document.querySelector('#dashboard-capacity'), rect = card.getBoundingClientRect();
        return { text: card.innerText, curve: Boolean(card.querySelector('polyline')), left: rect.left,
          right: rect.right, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
      })())`));
      assert.ok(shown.text.includes(`Max useful agents now: ${displayCapacityNumber(capacity.agents.recommended)} (${displayCapacityNumber(capacity.agents.lower)}–${displayCapacityNumber(capacity.agents.upper)}).`));
      assert.ok(shown.text.includes(`Finish in about ${displayCapacityNumber(capacity.finishHours.lower)}–${displayCapacityNumber(capacity.finishHours.upper)} h.`));
      assert.ok(shown.text.includes(`Binding: ${capacity.binding.kind}. ${capacity.binding.text}`));
      assert.ok(shown.text.includes(`Lever: ${capacity.lever.text}`));
      assert.equal(shown.curve, true, 'the measured work/span curve appears');
      assert.ok(shown.left >= 0 && shown.right <= width + 1 && shown.page <= width + 1,
        `capacity card fits ${width}px: ${JSON.stringify(shown)}`);
    }
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); rmSync(profile, { recursive: true, force: true }); }
  }
});

/** Match the actual state request for the selected private board, not another page resource. */
function isBoardStateRequest(request, boardId) {
  return request.method === 'GET'
    && new URL(request.url).pathname === `/api/v1/boards/${encodeURIComponent(boardId)}/state`;
}
