// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through live moves [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openShoutConversation, SPEC, machine, project, build, accept, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

/** Inspect actual DOM lists and the page's current native snapshot; never call its projection helpers. */
function countPairs() {
  const p = data.project, pairs = [];
  /** Read rendered nodes, including folded rows that still belong to their labeled set. */
  const all = selector => [...document.querySelectorAll(selector)];
  /** Parse the displayed integer without letting locale separators change its value. */
  const number = node => Number.parseInt(node?.textContent.replaceAll(',', '') || '0', 10);
  /** Preserve the surface name beside each independently observed value. */
  const add = (label, actual, expected) => pairs.push({ label, actual, expected });
  /** A source-only count must expose a real hover source, not just its visible number. */
  const source = selector => {
    for (const node of all(selector)) add('source tooltip/' + selector, Boolean(node.closest('[title]')?.getAttribute('title')?.trim()), true);
  };
  const items = p.items.filter(item => item.status !== 'withdrawn');
  const active = items.filter(item => item.status !== 'verified');
  const gated = active.filter(item => item.status === 'open' && (item.blockedBy.length || p.holds.some(hold => hold.hold_lane === item.lane)));
  for (const [key, rows] of [['items', active], ['verify', items.filter(item => item.status === 'submitted')], ['gated', gated]]) {
    add('status/' + key, number(document.querySelector('[data-status="' + key + '"] b')), rows.length);
  }
  const needs = p.needs.reduce((total, row) => total + (row.kind === 'draft' ? row.count : 1), 0);
  if (view.tab !== 'roadmap') add('browser title/person calls', Number(/^\((\d+)\)/.exec(document.title)?.[1] || 0), needs);
  if (view.tab === 'items' && view.itemsView === 'list') {
    const selected = document.querySelector('[data-filter-kind="state"][aria-checked="true"]');
    add('Items/selected filter', number(selected?.querySelector('b')), all('#chain > [data-item]').length);
  }
  if (view.tab === 'items' && view.itemsView === 'pipeline') {
    for (const stage of all('#pipeline [data-pipeline-stage]')) {
      add('Pipeline/' + stage.dataset.pipelineStage, number(stage.querySelector('[data-stage-count]')), stage.querySelectorAll('.pipeline-item').length);
    }
  }
  if (view.tab === 'dashboard' || view.tab === 'items') {
    const root = view.tab === 'dashboard' ? '#dashboard' : '#needs';
    for (const group of all(root + ' .needs-group')) {
      const heading = group.querySelector('.needs-group-head h3');
      if (heading) add('Needs/' + heading.textContent, Number(heading.textContent.split('·').at(-1).trim()), group.querySelector('ol').children.length);
    }
    const draft = document.querySelector(root + ' .needs-drafts .needs-copy b');
    if (draft) add('Needs/draft rows', number(draft), p.needs.find(row => row.kind === 'draft')?.count ?? 0);
    if (view.tab === 'dashboard' && view.addressDetail !== 'floor') {
      const approved = p.spec.filter(row => row.status === 'approved');
      const ruleCounts = all('#dashboard-rules [data-home-count]');
      add('Dashboard/rules card rows', ruleCounts.length, 3);
      for (const [key, expected] of [['approved', approved.length], ['gated', approved.filter(row => String(row.gate ?? '').trim()).length], ['ungated', approved.filter(row => !String(row.gate ?? '').trim()).length]]) {
        const count = document.querySelector('[data-home-count="' + key + '"] dd');
        add('Dashboard/rules/' + key + ' exists', Boolean(count), true);
        add('Dashboard/rules/' + key, number(count), expected);
      }
      source('[data-home-count]');
    }
  }
  if (view.tab === 'shouts') {
    add('Shouts/working agents footer', number(document.querySelector('[data-status="agents"] b')), all('#agents .agent-card').length);
    const pendingQuestions = new Set([...p.decisions, ...p.asked, ...(p.decisionQueue || [])].map(question => question.shout_id));
    add('Shouts/Questions segment', number(document.querySelector('[data-shout-filter=questions] b')), pendingQuestions.size);
    add('Shouts/replaced decisions wall', all('#decisions .shout').length, 0);
    const idle = document.querySelector('#agents [data-fold="idle"][aria-expanded="true"]');
    if (idle) add('Agents/idle', number(idle), all('#agents .idle-list .agent-pill').length);
    for (const card of all('#agents .agent-card')) {
      const more = card.querySelector('.agent-more');
      if (more && card.querySelector('.agent-work')) add('Agents/additional held items', number(more), card.querySelectorAll('.agent-work').length - 1);
      if (more) source('#agents .agent-more');
    }
  }
  if (view.tab === 'spec' || view.tab === 'doctrine') {
    const kind = view.tab, list = document.querySelector('#' + kind + '-list');
    add(kind + '/selected filter', number(document.querySelector('#' + kind + '-chips [aria-pressed="true"] b')), list.querySelectorAll('[data-row]').length);
    for (const head of list.querySelectorAll('.spec-section-head')) {
      let rows = 0, node = head.nextElementSibling;
      while (node && !node.matches('.spec-section-head')) { if (node.matches('[data-row]')) rows++; node = node.nextElementSibling; }
      add(kind + '/section/' + head.querySelector('h4').textContent, number(head.querySelector('.section-count')), rows);
      const approve = head.querySelector('[data-section-approve]');
      if (approve) add('Spec/section decisions', Number(/Approve all (\d+)/.exec(approve.textContent)?.[1]), p.spec.filter(row => row.section === approve.dataset.sectionApprove && (['pending', 'draft'].includes(row.status) && !row.decision || row.staleDecision)).length);
    }
    source('[data-section-approve]');
    for (const row of list.querySelectorAll('[data-row]')) {
      const id = row.dataset.row.split(':')[1], badge = row.querySelector('.spec-row-side small');
      add(kind + '/citations/' + id, number(badge), items.filter(item => item.specs.includes(id)).length);
    }
  }
  if (view.tab === 'activity') {
    add('Activity/selected filter', number(document.querySelector('#activity-filters [aria-pressed="true"] b')), all('#activity [data-activity-kind]').length);
  }
  if (view.tab === 'roadmap') {
    let remaining = 0;
    for (const card of all('#roadmap-list > .milestone')) {
      const rows = [...card.querySelectorAll('.milestone-item')];
      const landed = rows.filter(row => row.querySelector('[data-stage=merged]')).length;
      const left = card.querySelector('.roadmap-left b');
      if (left) { add('Roadmap/' + card.dataset.key + '/remaining', number(left), rows.length - landed); remaining += number(left); }
      for (const count of card.querySelectorAll('[data-summary-state]')) {
        const key = count.dataset.summaryState;
        // Rows carry the native stage chip (1484ea02be): data-stage names the stage, a Held mark names a hold.
        const matches = { landed: '[data-stage=merged]', landing: '[data-stage=verified], [data-stage=landing]', review: '[data-stage=in-review]', building: '[data-stage=building]', held: '.stage-mark[aria-label^="Held"]' };
        if (matches[key]) add('Roadmap/' + key, number(count.querySelector('b')), rows.filter(row => row.querySelector(matches[key])).length);
      }
    }
    add('Roadmap/browser remaining', Number(/^\((\d+) remaining\)/.exec(document.title)?.[1] || 0), remaining);
  }
  if (view.tab === 'dashboard' && view.addressDetail !== 'floor') {
    add('Dashboard/agents at work', number(document.querySelector('.dash-hero h1')), all('#dashboard .dash-agent-group').reduce((sum, head) => {
      let rows = 0, node = head.nextElementSibling;
      while (node?.matches('.dash-agent')) { rows++; node = node.nextElementSibling; }
      add('Dashboard/agent group/' + head.textContent, Number(head.textContent.split('·').at(-1).trim()), rows);
      return sum + rows;
    }, 0));
    const since = Date.now() - 24 * 3_600_000;
    const landedInDay = new Set(p.events.filter(event => event.event_kind === 'merged' && Date.parse(event.event_at) > since && p.dashboardLanded.some(item => item.id === event.item_id && item.commit === JSON.parse(event.event_detail).commit)).map(event => event.item_id));
    add('Dashboard/landed 24h', number(document.querySelector('.dash-accent')), p.dashboardPace?.last24h ?? landedInDay.size);
    const recentEvents = p.events.filter(event => Date.parse(event.event_at) > Date.now() - 4 * 3_600_000);
    const recentLandings = new Set(recentEvents.filter(event => event.event_kind === 'merged' && p.dashboardLanded.some(item => item.id === event.item_id && item.commit === JSON.parse(event.event_detail).commit)).map(event => event.item_id));
    const chips = all('.dash-chips > span').slice(1);
    add('Dashboard/4h chip inventory', chips.length, 4);
    const historyLoading = all('#dashboard [aria-label="Agents"] .muted').some(node => node.textContent === 'Complete history is loading; historical totals are not yet available.');
    for (const [index, expected] of [recentLandings.size, recentEvents.filter(event => event.event_kind === 'accept').length,
      recentEvents.filter(event => ['reject', 'reopen'].includes(event.event_kind)).length,
      recentEvents.filter(event => event.event_kind === 'shout' && JSON.parse(event.event_detail).to === 'person').length].entries()) {
      const value = chips[index]?.textContent.trim().split(/\s+/)[0];
      if (value === '—') add('Dashboard/explicitly unknown historical count/' + index, historyLoading, true);
      else add('Dashboard/4h chip/' + index, Number.parseInt(value?.replaceAll(',', ''), 10), expected);
    }
    const rate = document.querySelector('.dash-rate');
    add('Dashboard/all-time landed', Number(/(\d[\d,]*) landed all time/.exec(rate.textContent)?.[1].replaceAll(',', '')), p.dashboardLanded.length);
    const bins = all('.dash-chart rect title').map(node => Number(/(\d+) landed$/.exec(node.textContent)?.[1] || 0));
    if (bins.length) {
      add('Dashboard/landing histogram total', bins.reduce((sum, count) => sum + count, 0), landedInDay.size);
      add('Dashboard/landing histogram peak', Number(/busiest hour (\d+)/.exec(document.querySelector('.dash-chart-caption').textContent)?.[1]), Math.max(...bins));
    }
    for (const flight of all('.dash-flight')) add('Dashboard/' + flight.querySelector('h3').textContent, Number(/\d+$/.exec(flight.querySelector('h3').textContent)?.[0] || 0), flight.querySelectorAll('li').length);
    const building = document.querySelector('[data-dashboard-stat="building"]');
    add('Dashboard/building', Number(building.dataset.value), items.filter(item => item.status === 'claimed').length);
    const release = p.milestones.find(milestone => !milestone.shipped && milestone.summary?.left > 0);
    if (release) {
      const entries = release.items.filter(ref => items.some(item => item.id === ref.id));
      const landed = entries.filter(ref => p.dashboardLanded.some(item => item.id === ref.id)).length;
      const headline = document.querySelector('.dash-release-card .roadmap-left');
      const progress = headline?.querySelector('[aria-label]')?.getAttribute('aria-label').match(/^(\d+)\/(\d+) landed$/);
      const summary = document.querySelector('.dash-release-card .roadmap-summary-bar');
      add('Dashboard/release remaining', number(headline?.querySelector('b')), entries.length - landed);
      add('Dashboard/release landed', Number(progress?.[1]), landed);
      add('Dashboard/release total', Number(progress?.[2]), entries.length);
      add('Dashboard/release accessible summary source', Boolean(summary?.getAttribute('aria-label')?.includes(release.name)), true);
    }
    source('.dash-hero h1, .dash-accent, .dash-rate, .dash-chips > span:not(:first-child)');
  }
  if (view.tab === 'dashboard' && view.addressDetail === 'floor') {
    source('[data-floor-stat], .floor-foot');
    const recent = p.events.filter(event => Date.parse(event.event_at) > Date.now() - 4 * 3_600_000);
    const landedIds = new Set(p.dashboardLanded.map(item => item.id));
    const dayIds = new Set(p.events.filter(event => event.event_kind === 'merged'
      && Date.parse(event.event_at) > Date.now() - 24 * 3_600_000
      && p.dashboardLanded.some(item => item.id === event.item_id && item.commit === JSON.parse(event.event_detail).commit)).map(event => event.item_id));
    const recentIds = new Set(recent.filter(event => event.event_kind === 'merged'
      && p.dashboardLanded.some(item => item.id === event.item_id && item.commit === JSON.parse(event.event_detail).commit)).map(event => event.item_id));
    const review = items.filter(item => item.status === 'submitted');
    const heldItems = new Set((p.itemHolds ?? []).map(hold => hold.item));
    const heldLanes = new Set(p.holds.map(hold => hold.hold_lane));
    const nativeQueues = {
      review: review.map(item => item.id),
      landing: items.filter(item => item.status === 'verified' && !landedIds.has(item.id)).map(item => item.id),
      ready: items.filter(item => item.status === 'open' && !item.blockedBy.length && !heldItems.has(item.id) && !heldLanes.has(item.lane)).map(item => item.id),
      landed: [...dayIds],
    };
    const queues = all('[data-floor-queue]');
    add('Floor/queue inventory', queues.length, 4);
    for (const queue of queues) {
      const key = queue.dataset.floorQueue, rows = [...queue.querySelectorAll('li')];
      add('Floor/queue/' + key, number(queue.querySelector('h2 b')), rows.length);
      add('Floor/queue native IDs/' + key, rows.map(row => Number(row.querySelector('[data-go]').dataset.go.split(':')[1])).sort((a, b) => a - b).join(','), nativeQueues[key].toSorted((a, b) => a - b).join(','));
    }
    for (const group of all('.floor-group')) {
      let rows = 0, node = group.nextElementSibling;
      while (node?.matches('[data-floor-agent]')) { rows++; node = node.nextElementSibling; }
      add('Floor/' + group.textContent, Number(group.textContent.split('·').at(-1).trim()), rows);
    }
    const agents = all('[data-floor-agent]');
    const building = agents.filter(row => row.classList.contains('floor-building')).length;
    const reviewing = agents.filter(row => row.classList.contains('floor-reviewing')).length;
    const between = agents.filter(row => row.classList.contains('floor-between-items')).length;
    const live = agents.filter(row => !row.classList.contains('floor-quiet')).length;
    const values = {
      // The Landed tile counts the last 4 hours; its group heading carries the 24-hour count (2ad0017969).
      live, building, reviewing, between, landed: recentIds.size,
      accepted: recent.filter(event => event.event_kind === 'accept').length,
      'sent-back': recent.filter(event => ['reject', 'reopen'].includes(event.event_kind)).length,
      'in-review': review.length, waiting: nativeQueues.landing.length, ready: nativeQueues.ready.length,
      shouts: recent.filter(event => event.event_kind === 'shout').length,
    };
    add('Floor/tile inventory', all('[data-floor-stat]').length, Object.keys(values).length);
    for (const [key, expected] of Object.entries(values)) {
      // Read the visible numeral: a stale data-value must never conceal a wrong tile.
      const numeral = document.querySelector('[data-floor-stat="' + key + '"] > b');
      add('Floor/tile/' + key, Number.parseInt(numeral?.textContent.replaceAll(',', ''), 10), expected);
    }
    // The seen-agents note moved to the Agents group heading (2ad0017969).
    add('Floor/seen agents note', number(document.querySelector('[data-floor-group="agents"] h2 span')), agents.length);
    add('Floor/day landed note', number(document.querySelector('[data-floor-group="recent"] h2 span')), dayIds.size);
    // Tile sub-lines moved into each tile's hover title (2ad0017969).
    add('Floor/unreviewed note', Number(/; (\d+) waiting for a reviewer$/u.exec(document.querySelector('[data-floor-stat="in-review"]')?.title ?? '')?.[1]), review.filter(item => !item.reviewer || !(Date.parse(item.reviewUntil) > Date.now())).length);
    const headline = document.querySelector('.floor-hero h1').textContent.replaceAll(',', '').match(/\d+/g).map(Number);
    // The headline reads landings in 24 hours, then peak agents (f1fb1e6fb7); the peak is never below the live count.
    add('Floor/headline/landed', headline[0], dayIds.size);
    add('Floor/headline/peak covers live', headline[1] >= live, true);
    add('Floor/all-time landed', number(document.querySelector('.floor-foot span')), landedIds.size);
    const bins = all('.floor-bars rect title').map(node => number(node));
    add('Floor/histogram inventory', bins.length, 24);
    add('Floor/histogram total', bins.reduce((sum, count) => sum + count, 0), dayIds.size);
    const landedCaption = document.querySelector('[aria-label="Landed per hour"] h2 span').textContent;
    const [, captionTotal, captionPeak] = /^([\d,]+) in 24 h · peak (\d+)\/h · [\d.]+\/h average$/u.exec(landedCaption) ?? [];
    add('Floor/caption 24h landed', Number(captionTotal?.replaceAll(',', '')), dayIds.size);
    add('Floor/caption peak per hour', Number(captionPeak), Math.max(...bins));
    for (const row of agents) add('Floor/agent shouts/' + row.dataset.floorAgent, number(row.querySelector('[data-label="Shouts"]')), recent.filter(event => event.event_kind === 'shout' && event.event_by === row.dataset.floorAgent).length);

  }
  return pairs;
}

/** Assert every observed pair with its own label so a new count mismatch names its surface. */
async function checkCounts(chrome, phase) {
  const pairs = await chrome.stable('window.countSweepPairs()');
  assert.ok(pairs.length >= 4, phase + ': shared and pane counts are actually checked');
  for (const pair of pairs) assert.equal(pair.actual, pair.expected, phase + ': ' + pair.label);
}

/** Open a real pane through the navigation and verify its current native snapshot's counts. */
async function pane(chrome, name, phase) {
  await press(chrome, 'document.querySelector("[data-tab=' + name + ']")');
  await chrome.waitFor('view.tab === ' + JSON.stringify(name) + ' && !document.querySelector("[data-pane=' + name + ']").hidden');
  await checkCounts(chrome, phase + '/' + name);
}

/** Check every tab, each counted filter choice, pipeline stage, and the separate Dashboard floor. */
async function sweep(chrome, phase) {
  for (const tab of ['dashboard', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap', 'settings']) {
    await pane(chrome, tab, phase);
    if (tab === 'items') {
      const states = await chrome.stable('[...document.querySelectorAll("[data-filter-kind=state]")].map(node => node.dataset.filterValue)');
      for (const state of states) {
        await press(chrome, 'document.querySelector("#filter-toggle")');
        await press(chrome, 'document.querySelector(' + JSON.stringify('[data-filter-choice="state:' + state + '"]') + ')');
        await checkCounts(chrome, phase + '/Items/' + state);
      }
      await press(chrome, 'document.querySelector("[data-items-view=pipeline]")');
      await checkCounts(chrome, phase + '/Pipeline');
      await press(chrome, 'document.querySelector("[data-items-view=list]")');
    }
    if (tab === 'shouts') {
      for (const fold of ['idle']) {
        if (await chrome.stable('!!document.querySelector(' + JSON.stringify('[data-fold="' + fold + '"][aria-expanded="false"]') + ')')) await press(chrome, 'document.querySelector(' + JSON.stringify('[data-fold="' + fold + '"]') + ')');
      }
      await press(chrome, 'document.querySelector("[data-shout-filter=questions]")');
      const expectedQuestions = await chrome.stable('[...new Set([...data.project.decisions, ...data.project.asked, ...(data.project.decisionQueue || [])].map(question => question.shout_id))]');
      const threads = await chrome.stable('[...document.querySelectorAll("#feed [data-shout-thread]")].map(button => button.dataset.shoutThread).filter(Boolean)');
      const visibleMessages = new Set();
      for (const key of threads) {
        await openShoutConversation(chrome, key);
        for (const id of await chrome.stable('[...document.querySelectorAll("#feed [data-shout-id]")].map(card => Number(card.dataset.shoutId))')) visibleMessages.add(id);
        await checkCounts(chrome, phase + '/Questions/' + key);
      }
      for (const id of expectedQuestions) assert.ok(visibleMessages.has(id), phase + ': every native pending question opens in a real conversation: ' + id);
      await press(chrome, 'document.querySelector("[data-shout-filter=all]")');
      const agents = await chrome.stable('[...document.querySelectorAll("#agents .agent-card [data-agent]")].map(node => node.dataset.agent)');
      for (const agent of agents) {
        await press(chrome, 'document.querySelector(' + JSON.stringify('#agents .agent-card [data-agent="' + agent + '"]') + ')');
        await checkCounts(chrome, phase + '/agent/' + agent);
      }
      await checkCounts(chrome, phase + '/Shouts expanded');
    }
    if (['spec', 'doctrine', 'activity'].includes(tab)) {
      const attribute = tab === 'activity' ? 'data-activity-filter' : 'data-rows';
      const selector = '#' + (tab === 'activity' ? 'activity-filters' : tab + '-chips') + ' [' + attribute + ']';
      const values = await chrome.stable('[...document.querySelectorAll(' + JSON.stringify(selector) + ')].map(node => node.getAttribute(' + JSON.stringify(attribute) + '))');
      for (const value of values) {
        await press(chrome, 'document.querySelector(' + JSON.stringify(selector + '[' + attribute + '="' + value + '"]') + ')');
        await checkCounts(chrome, phase + '/' + tab + '/' + value);
      }
    }
  }
  await pane(chrome, 'dashboard', phase);
  await chrome.waitFor('!!document.querySelector(".dash-floor-link")');
  await press(chrome, 'document.querySelector(".dash-floor-link")');
  await chrome.waitFor('view.addressDetail === "floor" && !!document.querySelector(".floor")');
  await chrome.waitFor('!document.querySelector(".floor-agents .muted")');
  await checkCounts(chrome, phase + '/floor');
  // Each independently corrupted visible tile must be detected while its data-value stays untouched.
  const controls = await chrome.stable(`(() => {
    return [...document.querySelectorAll('[data-floor-stat]')].map(tile => {
      const numeral = tile.querySelector('b'), original = numeral.textContent;
      numeral.textContent = '999';
      const pair = window.countSweepPairs().find(pair => pair.label === 'Floor/tile/' + tile.dataset.floorStat);
      numeral.textContent = original;
      return { key: tile.dataset.floorStat, detected: pair?.actual === 999 && pair.actual !== pair.expected };
    });
  })()`);
  assert.equal(controls.length, 11, phase + ': all Floor tile controls ran');
  for (const control of controls) assert.equal(control.detected, true, phase + ': detects corrupted Floor ' + control.key);
  await checkCounts(chrome, phase + '/floor restored');
  await press(chrome, 'document.querySelector(".floor-crumbs a")');
}

/** Watch every visible render during one real native move, without refreshing or replacing page state. */
async function liveMove(chrome, move, witness, phase) {
  await chrome.stable(`(() => {
    window.countSweepErrors = [];
    window.countSweepObserver = new MutationObserver(() => {
      for (const pair of window.countSweepPairs()) if (pair.actual !== pair.expected) window.countSweepErrors.push(pair);
    });
    window.countSweepObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  })()`);
  move();
  await chrome.waitFor(witness);
  await checkCounts(chrome, phase);
  const errors = await chrome.stable('(() => { window.countSweepObserver.disconnect(); return window.countSweepErrors; })()');
  assert.deepEqual(errors, [], phase + ': counts and lists agree on each observed live render');
  await sweep(chrome, phase);
}

// budget: native board setup, all tab/filter choices and three streamed updates; no speed threshold.
test('clause 1: every tab count describes its real list or named native set across landing, add and claim refreshes [N26]', { timeout: 240_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'this journey requires an admitted Chrome runner');
  const box = machine();
  const demo = project(box, 'count-sweep', SPEC + '\n- G3 [draft, must] A proposed footer. | gate: browser\n- G4 [pending] Choose the heading. | gate: review\n', { practice: 'DOCTRINE.md' });
  writeFileSync(join(demo.repo, 'DOCTRINE.md'), '# Doctrine\n\n## Local\n- R1 [approved, must] Count actual work. | gate: browser\n- R2 [draft, must] A proposed rule. | gate: browser\n');
  for (const title of ['Ready to land', 'Waiting for review', 'Ready to claim', 'Another ready item', 'Gated item']) {
    box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The page counts this native item.', ...(title === 'Gated item' ? ['--after', '3'] : []));
  }
  build(box, demo, 1, 'land.txt'); accept(box, demo, 1);
  build(box, demo, 2, 'review.txt');
  box.run(demo.repo, 'milestone', 'add', 'Release', '--items', '1,2,3,4,5', '--reason', 'Arrange fixture release');
  box.run(demo.repo, 'shout', 'person', 'Choose the release wording.', '--decision');
  box.run(demo.web, 'shout', 'coordinator', 'Which item should follow?', '--decision', '--kind', 'question');
  const server = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-count-sweep-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('data?.project?.items?.length === 5');
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the usual Dashboard counts are swept.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.stable('window.countSweepPairs = ' + countPairs.toString());
    await sweep(chrome, 'initial');
    await pane(chrome, 'roadmap', 'before landing');
    await liveMove(chrome, () => {
      box.git(demo.repo, 'merge', '--no-ff', '--no-edit', demo.itemBranches.get(`${demo.baseBranch}:1`));
      box.run(demo.repo, 'merged', '1', box.git(demo.repo, 'rev-parse', 'HEAD'));
    }, 'document.querySelectorAll("#roadmap [data-stage=merged]").length === 1', 'landed');
    await pane(chrome, 'settings', 'before add');
    await liveMove(chrome, () => box.run(demo.repo, 'add', 'web', 'Live added item', '--specs', 'G1', '--criterion', 'Count the live addition.'), 'data.project.items.length === 6', 'added');
    await pane(chrome, 'dashboard', 'before claim');
    await liveMove(chrome, () => box.run(demo.web, 'claim', '3'), 'document.querySelector("[data-dashboard-stat=building]")?.dataset.value === "1" && [...document.querySelectorAll(".dash-chips > span")].slice(1).every(node => /^\\d/.test(node.textContent.trim()))', 'claimed');
    assert.deepEqual(chrome.exceptions, [], 'every tab and live move stays executable');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
