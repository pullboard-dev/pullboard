// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-journey The first-run Dashboard teaches the loop on an empty board and gives way to the usual Dashboard as work lands [N26,N38]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { firstRunKit } from '../../apps/view/index.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, build, accept } from './fixture.js';

const kit = firstRunKit();
/** Words a first-run reader never sees, apart from the literal strings the approved design itself uses. */
const BANNED = /\b(main|items?|tests?|subagents?)\b|github|claude|codex|openai|anthropic|\bnpm\b|vercel|netlify/iu;
/** How long past its dwell the tour may take to make its first move on a loaded runner. */
const TOUR_SLACK = kit.dwell(0) * 3;
const ALLOWED = ['Items →', 'Tests pass', 'subagents'];
/** Visible words with the design's own literals taken out, so a banned word anywhere else fails. */
const plain = text => ALLOWED.reduce((left, allowed) => left.replaceAll(allowed, ''), text);

test('the checklist ticks from native events, in the approved order, and Walk away never ticks [N26]', () => {
  const tick = (project, events = []) => kit.model(project, events).ticks;
  assert.deepEqual(tick({}), [false, false, false, false, false, false, false]);
  assert.equal(tick({ agents: [{ agent_id: 'coordinator-1', agent_lane: 'coordinator' }] })[0], true, 'a coordinator seat on the board ticks step 1');
  assert.equal(tick({ agents: [{ agent_id: 'web-1', agent_lane: 'web' }] })[0], false, 'a builder seat is not a coordinator');
  assert.equal(tick({ spec: [{ id: 'G1', status: 'approved' }] })[1], true, 'an approved row ticks step 2');
  assert.equal(tick({ spec: [{ id: 'G1', status: 'pending' }] })[1], false);
  assert.equal(tick({}, [{ event_kind: 'submit' }])[2], true, 'the first submit ticks step 3');
  assert.equal(tick({}, [{ event_kind: 'accept' }])[3], true, 'the first accept ticks step 4');
  assert.deepEqual(tick({}, [{ event_kind: 'merged' }]).slice(4, 6), [true, false], 'the first landing ticks step 5 only');
  assert.deepEqual(tick({}, [{ event_kind: 'merged' }, { event_kind: 'merged' }]).slice(4, 6), [true, true], 'a second landing ticks step 6');
  assert.equal(tick({ milestones: [{ items: [1, 2] }] })[6], false, 'two items are not a plan');
  assert.equal(tick({ milestones: [{ items: [1, 2, 3] }] })[6], true, 'a release of three or more ticks step 7');
  const all = kit.model({ agents: [{ agent_id: 'coordinator-1', agent_lane: 'coordinator' }], spec: [{ status: 'approved' }], milestones: [{ items: [1, 2, 3] }] }, [{ event_kind: 'submit' }, { event_kind: 'accept' }, { event_kind: 'merged' }, { event_kind: 'merged' }]);
  assert.equal(all.done, true, 'seven ticks finish the checklist');
  assert.equal(kit.visible(all, false), false, 'a proven loop (coordinator present, item landed) takes the page away');
  assert.equal(kit.visible({ ...all, ticks: [false, ...all.ticks.slice(1)] }, false), true, 'landed work without a coordinator keeps the page up');
  assert.equal(kit.visible({ ...all, ticks: [false, ...all.ticks.slice(1)] }, true), false, 'hiding it brings back the usual Dashboard');
  assert.match(kit.html({ ...all, landed: 3 }), /Walk away\.[\s\S]*Set up your phone[\s\S]*data-first-run-hide>Hide this page/u, 'step 7 shows Walk away, the phone line and Hide this page');
  const finished = kit.html(all);
  assert.match(finished, /data-first-run-walk[^>]*>Walk away\.<small class="hint">We'll call you if it's on fire 🔥 · <a [^>]*data-first-run-phone[^>]*>Set up your phone →<\/a>/u, 'the end shows the phone line');
  assert.doesNotMatch(kit.html(kit.model({}, [])), /Set up your phone/u, 'the phone line waits for the end');
  assert.doesNotMatch(kit.html(kit.model({}, [])), /data-first-run-walk data-ticked/u, 'Walk away carries no tick');
});

test('each step shows its pointer while it is current, and the tour stops add words and last long enough to read [N26]', () => {
  const pointers = ['Paste the line above', 'Approve in Spec →', 'Watch it in Items →', 'See the check in Activity →', 'See what landed on the Dashboard →', 'Go get a coffee ☕', 'Plan releases in Roadmap →'];
  for (const [at, pointer] of pointers.entries()) {
    const ticks = pointers.map((_, index) => index < at);
    const html = kit.html({ ticks, done: false, current: at, landed: 0, tiles: [] });
    assert.equal(/<small class="hint">([^]*?)<\/small>/u.exec(html.slice(html.indexOf('first-run-checks')))?.[1].replace(/<[^>]*>/gu, ''), pointer, `step ${at + 1} points the way`);
  }
  const said = kit.steps.map(([, line]) => line);
  assert.equal(new Set(said).size, said.length, 'no stop repeats another');
  assert.equal(kit.steps.length, 5, 'one stop for each box');
  kit.steps.forEach(([, line], index) => assert.equal(kit.dwell(index), 2500 + 330 * line.split(/\s+/u).length, `stop ${index + 1} stays 2.5 s plus a third of a second per word`));
});

test('no first-run text uses the banned words or a product name, with or without work [N26]', () => {
  const text = html => plain(html.replace(/<[^>]*>/gu, ' '));
  for (const state of [kit.model({}, []), kit.model({ spec: [{ id: 'G1', status: 'approved' }] }, [{ event_kind: 'merged' }])]) assert.doesNotMatch(text(kit.html(state)), BANNED);
  for (let at = 0; at < 7; at++) assert.doesNotMatch(text(kit.html({ ticks: [0, 1, 2, 3, 4, 5, 6].map(index => index < at), done: false, current: at, landed: 1, tiles: [] })), BANNED, `step ${at + 1}`);
  assert.doesNotMatch(text(kit.html(kit.model({ agents: [{ agent_lane: 'coordinator', agent_id: 'c-1' }], spec: [{ status: 'approved' }], milestones: [{ items: [1, 2, 3] }] }, [{ event_kind: 'submit' }, { event_kind: 'accept' }, { event_kind: 'merged' }, { event_kind: 'merged' }]))), BANNED, 'the finished page');
});

test('the Architecture tiles read the board\'s setup facts and the active doctrine count [N26]', () => {
  const model = kit.model({ spec: [{ id: 'Q1', text: 'Runs on: Node.js.' }, { id: 'Q2', text: 'Hosting: Free; provider undecided.' }, { id: 'Q3', text: 'Sign-in: Built in; no outside accounts needed.' }, { id: 'Q4', text: 'Done means: Tests pass.' }],
    practice: [{ status: 'approved' }, { status: 'approved' }, { status: 'declined' }] });
  assert.deepEqual(model.tiles.map(tile => [tile.label, tile.value, tile.link]), [['Runs on', 'Node.js', 'Change'], ['Hosting', 'Free', 'Change'], ['Sign-in', 'Built in', 'Change'], ['Done means', 'Tests pass', 'Change'], ['Doctrine', '2 rules', 'Review']]);
  assert.equal(kit.model({ practice: [{ status: 'approved' }] }).tiles[4].value, '1 rule');
  assert.equal(kit.model({}).tiles[0].link, 'Set', 'a missing setup fact offers to set it, not a made-up value');
});

/** What the page's layout clauses measure at the current width. */
const MEASURE = `(() => {
  const all = selector => [...document.querySelectorAll(selector)];
  const box = element => { const rect = element.getBoundingClientRect(); return { top: Math.round(rect.top + scrollY), left: Math.round(rect.left), width: rect.width, height: rect.height }; };
  const style = (element, name) => getComputedStyle(element)[name];
  const line = element => element.getBoundingClientRect().height < parseFloat(style(element, 'lineHeight')) * 1.6;
  const tile = all('.first-run-tile');
  return {
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    rules: all('.first-run-rules li:not(.arr)').map(item => ({ text: item.textContent, box: box(item), second: { oneLine: line(item.querySelector('em')), color: style(item.querySelector('em'), 'color'), fits: item.querySelector('em').scrollWidth <= item.querySelector('em').clientWidth + 1 } })),
    arrows: all('.first-run-rules .arr').length,
    card: box(document.querySelector('.first-run-card')),
    columns: { how: box(document.querySelector('.first-run-how')), start: box(document.querySelector('.first-run-start')) },
    tiles: tile.map(element => ({ label: element.dataset.firstRunTile, box: box(element), text: element.querySelector('.k').textContent, value: element.querySelector('b').textContent, link: element.querySelector('a').textContent,
      bg: style(element, 'backgroundColor'), border: style(element, 'borderTopWidth'), shadow: style(element, 'boxShadow'), radius: style(element, 'borderTopLeftRadius'),
      icon: box(element.querySelector('.ico')), iconBg: style(element.querySelector('.ico'), 'backgroundColor'),
      labelSize: style(element.querySelector('.k'), 'fontSize'), labelTransform: style(element.querySelector('.k'), 'textTransform'), labelFont: style(element.querySelector('.k'), 'fontFamily'), labelOneLine: line(element.querySelector('.k')),
      valueSize: style(element.querySelector('b'), 'fontSize'), valueWeight: style(element.querySelector('b'), 'fontWeight'), valueOneLine: line(element.querySelector('b')),
      linkColor: style(element.querySelector('a'), 'color'), linkDisplay: style(element.querySelector('a'), 'display'), linkTop: box(element.querySelector('a')).top, valueBottom: box(element.querySelector('b')).top + box(element.querySelector('b')).height })),
    surface: style(document.querySelector('.first-run-card'), 'backgroundColor'),
    accentStrong: style(document.querySelector('.first-run-arch h2'), 'color'),
  };
})()`;

test('a fresh board opens on the first-run page: three boxes, the loop, the checklist and the Architecture tiles at desktop, 1240px and phone widths [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required');
  const box = machine(), alpha = project(box, 'first-run');
  box.run(alpha.repo, 'blueprint', 'add', 'web-app');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'first-run-chrome'));
    await chrome.waitFor('!!data?.project && !!document.querySelector("#dashboard .first-run")');
    // Hidden until work starts: the numbers, the window comparison and the Pipeline card.
    assert.equal(await chrome.stable('document.querySelectorAll("#dashboard .dash-hero, #dashboard .dash-comparison, #dashboard [aria-label=Pipeline], #dashboard [data-dashboard-stat]").length'), 0, 'no stats, comparison or Pipeline card before work');
    assert.match(await chrome.stable('document.querySelector("#dashboard .first-run-line code").textContent'), /^Use the pullboard-run skill: be this project's coordinator\. Keep listening, run builder and verifier subagents, and help me add more agents\.$/u, 'the line to copy, until the coordinate command exists');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .first-run-start h2").textContent'), 'Create your Coordinator Agent');
    const checks = JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#dashboard [data-first-run-check]")].map(li => [li.textContent.replace(/^[✓0-9]+/u, ""), li.dataset.ticked]))'));
    assert.deepEqual(checks.map(([name]) => name.replace(/Paste the line above$/u, '')), ['Coordinator created', 'Declared and approved', 'First task built', 'First task verified', 'Your app updated', 'Rinse and repeat', 'Map out the work'], 'seven steps in the approved order');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .after").textContent'), 'Walk away.', 'then an unnumbered Walk away');
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-first-run-check=\\"0\\"] .hint").textContent'), 'Paste the line above', 'the current step points the way');
    assert.deepEqual(checks.map(([, ticked]) => ticked).filter((_, index) => index !== 1), ['false', 'false', 'false', 'false', 'false', 'false'], 'nothing has happened yet');
    const words = await chrome.stable('document.querySelector("#dashboard .first-run").innerText');
    assert.doesNotMatch(plain(words), BANNED, 'no banned word or product name on the page');
    assert.doesNotMatch(words, /phone/iu, 'phone setup lives in the final Walk away line, not in a setup card');
    const seen = {};
    for (const width of [1440, 1240, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      const m = seen[width] = await chrome.stable(MEASURE);
      assert.equal(m.fits, true, `no sideways scroll at ${width}px`);
      // Clause 1: three boxes with arrows, green second lines that never wrap; the row stacks under about 1240px.
      assert.equal(m.rules.length, 3);
      assert.deepEqual(m.rules.map(rule => rule.text.replace(/^\d/u, '')), ['Your board runs on its own:build → verify → add to your app', 'Talk to your coordinator agentIt runs everything', 'Want it faster?Add agents: “run pullboard next”']);
      for (const rule of m.rules) assert.equal(rule.second.oneLine && rule.second.fits, true, `second lines never wrap at ${width}px: ${rule.text}`);
      assert.equal(new Set(m.rules.map(rule => rule.second.color)).size, 1, 'the second lines share one green');
      assert.equal(new Set(m.rules.map(rule => rule.box.top)).size, width > 1240 ? 1 : 3, width > 1240 ? 'three boxes in one row' : `the boxes stack at ${width}px`);
      // Clause 2: one light card, two columns until the width runs out.
      if (width > 1000) assert.ok(m.columns.start.left > m.columns.how.left + m.columns.how.width - 2 && m.columns.start.top === m.columns.how.top, `diagram left, checklist right at ${width}px`);
      else assert.ok(m.columns.start.top > m.columns.how.top, `the columns stack at ${width}px`);
      // Clause 4 and the addenda: five equal tiles in one row, two columns under about 1100px.
      assert.deepEqual(m.tiles.map(tile => tile.label), ['Runs on', 'Hosting', 'Sign-in', 'Done means', 'Doctrine']);
      assert.deepEqual(m.tiles.map(tile => [tile.value, tile.link]), [['Node.js', 'Change'], ['Free', 'Change'], ['Built in', 'Change'], ['Tests pass', 'Change'], [m.tiles[4].value, 'Review']]);
      assert.match(m.tiles[4].value, /^\d+ rules?$/u, 'Doctrine reads a count of rules');
      if (width > 1100) {
        assert.equal(new Set(m.tiles.map(tile => tile.box.top)).size, 1, `five tiles in one row at ${width}px`);
        assert.ok(Math.max(...m.tiles.map(tile => tile.box.width)) - Math.min(...m.tiles.map(tile => tile.box.width)) < 2, 'the five tiles are equal');
      } else assert.equal(new Set(m.tiles.map(tile => tile.box.left)).size, 2, `two columns of tiles at ${width}px`);
      for (const tile of m.tiles) {
        assert.equal(tile.bg, m.surface, `${tile.label}: white surface, not a grey fill`);
        assert.equal(tile.border, '1px');
        assert.notEqual(tile.shadow, 'none', `${tile.label}: a light shadow`);
        assert.deepEqual([tile.icon.width, tile.icon.height], [32, 32], `${tile.label}: a 32px icon square`);
        assert.notEqual(tile.iconBg, 'rgba(0, 0, 0, 0)');
        assert.equal(tile.labelSize, '12px'); assert.equal(tile.valueSize, '15px');
        assert.ok(Number(tile.valueWeight) >= 700, `${tile.label}: a bold value`);
        assert.equal(tile.labelTransform, 'none', 'no uppercase labels'); assert.doesNotMatch(tile.labelFont, /mono|menlo|consolas/iu, 'no mono labels');
        assert.equal(tile.labelOneLine && tile.valueOneLine, true, `${tile.label}: label and value never wrap at ${width}px`);
        assert.equal(tile.linkColor, m.accentStrong, `${tile.label}: a green link`);
        assert.ok(tile.linkTop >= tile.valueBottom - 1, `${tile.label}: the link sits under the value`);
      }
    }
    // Real values from the board's own setup facts, and the Doctrine count from its active rules.
    assert.equal(seen[1440].tiles[4].value, await chrome.stable('(() => { const n = data.project.practice.filter(row => row.status === "approved").length; return n + (n === 1 ? " rule" : " rules"); })()'));
    // The diagram: five boxes, square connectors, a dashed way back and a way round to the next task.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1440');
    const diagram = JSON.parse(await chrome.stable(`JSON.stringify({ nodes: [...document.querySelectorAll('#dashboard [data-first-run-node]')].map(node => [...node.querySelectorAll('text')].map(text => text.textContent).join(' / ')),
      forward: document.querySelectorAll('#dashboard .first-run-dia > svg > path:not(.back):not(.next)').length, back: !!document.querySelector('#dashboard .first-run-dia path.back'), next: !!document.querySelector('#dashboard .first-run-dia path.next'),
      backDashed: getComputedStyle(document.querySelector('#dashboard .first-run-dia path.back')).strokeDasharray !== 'none', backColor: getComputedStyle(document.querySelector('#dashboard .first-run-dia path.back')).stroke,
      labels: [...document.querySelectorAll('#dashboard .first-run-dia .lbl')].map(text => text.textContent),
      square: [...document.querySelectorAll('#dashboard .first-run-dia > svg > path')].every(path => /^M[\\d. ]+[HV]/u.test(path.getAttribute('d')) && !/[CQSAcqsa]/u.test(path.getAttribute('d'))) })`));
    assert.deepEqual(diagram.nodes, ['You / declare it, then approve', 'Coordinator (agent) / runs everything', 'Builder (agent) / does one task', 'Verifier (agent) / verifies it', 'Your app / updates']);
    assert.equal(diagram.forward, 4, 'four connectors down the loop');
    assert.deepEqual([diagram.back, diagram.next, diagram.backDashed, diagram.square], [true, true, true, true], 'a dashed back to fix and a next task path, all square');
    assert.deepEqual(diagram.labels.sort(), ['back to fix', 'next task']);
    // The auto tour: one box lit at a time, the dwell is 2.5 s plus 0.33 s a word, arrows and dots step it.
    const tour = () => chrome.stable('JSON.stringify({ step: document.querySelector("[data-first-run-tour]").dataset.step, lit: [...document.querySelectorAll("[data-first-run-node].now")].map(node => node.dataset.firstRunNode), caption: document.querySelector("[data-first-run-caption]").textContent, dwell: Number(document.querySelector("[data-first-run-caption]").dataset.dwell), dots: document.querySelectorAll("[data-first-run-dot]").length, on: [...document.querySelectorAll("[data-first-run-dot]")].findIndex(dot => dot.classList.contains("on")) })').then(JSON.parse);
    // The harness forces reduced motion, which keeps the tour still; answer that one query as a motion-friendly person's browser would, then reload.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "{ const real = window.matchMedia.bind(window); window.matchMedia = query => /prefers-reduced-motion/u.test(query) ? { matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(query); }" });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('!!data?.project && !!document.querySelector("#dashboard [data-first-run-tour]")');
    const start = Date.now(), first = await tour();
    assert.deepEqual([first.step, first.lit, first.caption, first.dots, first.on], ['0', ['0'], kit.steps[0][1], 5, 0], 'the tour opens on You with one caption');
    assert.equal(first.dwell, kit.dwell(0));
    await chrome.waitFor('document.querySelector("[data-first-run-tour]").dataset.step === "1"', kit.dwell(0) + TOUR_SLACK);
    const waited = Date.now() - start, second = await tour();
    assert.ok(waited >= kit.dwell(0) - 500 && waited <= kit.dwell(0) + 4000, `the tour waited about ${kit.dwell(0)} ms before its first move, not ${waited}`);
    assert.deepEqual([second.lit, second.caption, second.on], [['1'], kit.steps[1][1], 1]);
    assert.notEqual(second.caption, first.caption, 'a stop adds a line, never repeats one');
    assert.equal(second.dwell, kit.dwell(1));
    await press(chrome, 'document.querySelector("[data-first-run-step=\\"1\\"]")');
    assert.equal((await tour()).step, '2', 'the next arrow steps once');
    await press(chrome, 'document.querySelector("[data-first-run-step=\\"-1\\"]")');
    await press(chrome, 'document.querySelector("[data-first-run-step=\\"-1\\"]")');
    await press(chrome, 'document.querySelector("[data-first-run-step=\\"-1\\"]")');
    assert.equal((await tour()).step, '4', 'the previous arrow wraps round to the last stop');
    await new Promise(done => setTimeout(done, kit.dwell(4) + 600));
    assert.equal((await tour()).step, '4', 'stepping by hand stops the tour moving on its own');
    // Live ticks: a release of three tasks ticks Map out the work without a reload.
    box.run(alpha.repo, 'milestone', 'add', 'First release', '--reason', 'Arrange fixture release', '--items', '1,2,3');
    await chrome.waitFor('document.querySelector("#dashboard [data-first-run-check=\\"6\\"]")?.dataset.ticked === "true"');
    // Links: the tiles open the row or the Doctrine tab.
    await press(chrome, 'document.querySelector("#dashboard [data-first-run-tile=\\"Doctrine\\"] a")');
    await chrome.waitFor('view.tab === "doctrine"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('!!document.querySelector("#dashboard .first-run")');
    await press(chrome, 'document.querySelector("#dashboard [data-first-run-tile=\\"Runs on\\"] a")');
    await chrome.waitFor('view.tab === "spec"');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});

test('once work lands the usual Dashboard follows the first-run page, which the person can hide [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required');
  const box = machine(), alpha = project(box, 'first-run-landed');
  box.run(alpha.repo, 'add', 'web', 'A first landed task', '--specs', 'G1', '--criterion', 'The first task lands.');
  build(box, alpha, 1, 'landed-1.txt');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: land the first task', alpha.itemBranches.get(`${alpha.baseBranch}:1`));
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'first-run-landed-chrome'));
    await chrome.waitFor('!!data?.project && !!document.querySelector("#dashboard .first-run") && !!document.querySelector("#dashboard .dash-hero")');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .first-run-checks [data-first-run-check=\\"4\\"]").dataset.ticked'), 'true', 'the first landing ticks Your app updated');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .first-run-checks [data-first-run-check=\\"5\\"]").dataset.ticked'), 'false', 'one landing is not rinse and repeat');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .first-run").compareDocumentPosition(document.querySelector("#dashboard .dash-hero")) & Node.DOCUMENT_POSITION_FOLLOWING'), 4, 'the usual Dashboard follows the first-run page');
    await press(chrome, 'document.querySelector("#dashboard [data-first-run-hide]")');
    await chrome.waitFor('!document.querySelector("#dashboard .first-run") && !!document.querySelector("#dashboard .dash-hero")');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .dash-hero") !== null'), true, 'hiding leaves the usual Dashboard');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
