/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through live moves [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, machine, project, build, accept, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

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
  if (view.tab === 'home' || view.tab === 'items') {
    const root = view.tab === 'home' ? '#home-needs' : '#needs';
    for (const group of all(root + ' .needs-group')) {
      const heading = group.querySelector('.needs-group-head h3');
      if (heading) add('Needs/' + heading.textContent, Number(heading.textContent.split('·').at(-1).trim()), group.querySelector('ol').children.length);
    }
    const draft = document.querySelector(root + ' .needs-drafts .needs-copy b');
    if (draft) add('Needs/draft rows', number(draft), p.needs.find(row => row.kind === 'draft')?.count ?? 0);
    if (view.tab === 'home') {
      const approved = p.spec.filter(row => row.status === 'approved');
      for (const [key, expected] of [['approved', approved.length], ['gated', approved.filter(row => String(row.gate ?? '').trim()).length], ['ungated', approved.filter(row => !String(row.gate ?? '').trim()).length]]) {
        add('Home/rules/' + key, number(document.querySelector('[data-home-count="' + key + '"] dd')), expected);
      }
      source('[data-home-count]');
    }
  }
  if (view.tab === 'shouts') {
    add('Shouts/asks waiting', number(document.querySelector('[data-fold="waiting"]')), p.asked.length);
    add('Shouts/decision rows', all('#decisions .shout').length, p.decisions.length + (view.open.waiting ? p.asked.length : 0));
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
      const id = row.dataset.row.split(':')[1], badge = row.querySelector('.row-age');
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
      const landed = rows.filter(row => row.querySelector('.roadmap-landed')).length;
      const left = card.querySelector('.roadmap-left b');
      if (left) { add('Roadmap/' + card.dataset.key + '/remaining', number(left), rows.length - landed); remaining += number(left); }
      for (const count of card.querySelectorAll('[data-summary-state]')) {
        const key = count.dataset.summaryState;
        const matches = { landed: '.roadmap-landed', landing: '.chip.ok:not(.roadmap-landed)', review: '.roadmap-status .chip.warn:not(.roadmap-blocked)', building: '.roadmap-status .chip.busy', held: '.held-chip' };
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
    for (const flight of all('.dash-flight')) add('Dashboard/' + flight.querySelector('h3').textContent, Number(/\d+$/.exec(flight.querySelector('h3').textContent)?.[0] || 0), flight.querySelectorAll('li').length);
    const building = document.querySelector('[data-dashboard-stat="building"]');
    add('Dashboard/building', Number(building.dataset.value), items.filter(item => item.status === 'claimed').length);
    const release = p.milestones.find(milestone => !milestone.shipped && milestone.summary?.left > 0);
    if (release) add('Dashboard/release remaining', number(document.querySelector('.dash-release b')), release.items.filter(ref => {
      const item = items.find(item => item.id === ref.id); return item && !p.dashboardLanded.some(landed => landed.id === item.id);
    }).length);
    source('.dash-hero h1, .dash-accent, .dash-rate, .dash-chips > span:not(:first-child), .dash-release, .dash-stats');
  }
  if (view.tab === 'dashboard' && view.addressDetail === 'floor') {
    source('[data-floor-stat], .floor-foot');
    for (const queue of all('[data-floor-queue]')) add('Floor/' + queue.dataset.floorQueue, number(queue.querySelector('h2 b')), queue.querySelectorAll('li').length);
    for (const group of all('.floor-group')) {
      let rows = 0, node = group.nextElementSibling;
      while (node?.matches('[data-floor-agent]')) { rows++; node = node.nextElementSibling; }
      add('Floor/' + group.textContent, Number(group.textContent.split('·').at(-1).trim()), rows);
    }
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
  for (const tab of ['dashboard', 'home', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap', 'settings']) {
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
      for (const fold of ['waiting', 'idle']) {
        if (await chrome.stable('!!document.querySelector(' + JSON.stringify('[data-fold="' + fold + '"][aria-expanded="false"]') + ')')) await press(chrome, 'document.querySelector(' + JSON.stringify('[data-fold="' + fold + '"]') + ')');
      }
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
  await checkCounts(chrome, phase + '/floor');
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
test('every tab count describes its real list or named native set across landing, add and claim refreshes [N26]', { timeout: 240_000 }, async () => {
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
  box.run(demo.repo, 'milestone', 'add', 'Release', '--items', '1,2,3,4,5');
  box.run(demo.repo, 'shout', 'person', 'Choose the release wording.', '--decision');
  box.run(demo.web, 'shout', 'coordinator', 'Which item should follow?', '--decision', '--kind', 'question');
  const server = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-count-sweep-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await chrome.waitFor('data?.project?.items?.length === 5');
    await chrome.stable('window.countSweepPairs = ' + countPairs.toString());
    await sweep(chrome, 'initial');
    await pane(chrome, 'roadmap', 'before landing');
    await liveMove(chrome, () => {
      box.git(demo.repo, 'merge', '--no-ff', '--no-edit', demo.itemBranches.get(`${demo.baseBranch}:1`));
      box.run(demo.repo, 'merged', '1', box.git(demo.repo, 'rev-parse', 'HEAD'));
    }, 'document.querySelectorAll("#roadmap .roadmap-landed").length === 1', 'landed');
    await pane(chrome, 'settings', 'before add');
    await liveMove(chrome, () => box.run(demo.repo, 'add', 'web', 'Live added item', '--specs', 'G1', '--criterion', 'Count the live addition.'), 'data.project.items.length === 6', 'added');
    await pane(chrome, 'dashboard', 'before claim');
    await liveMove(chrome, () => box.run(demo.web, 'claim', '3'), 'document.querySelector("[data-dashboard-stat=building]")?.dataset.value === "1"', 'claimed');
    assert.deepEqual(chrome.exceptions, [], 'every tab and live move stays executable');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
