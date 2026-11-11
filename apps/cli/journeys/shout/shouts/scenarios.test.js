// pullboard: browser
/** @pullboard-test-gui */
/** The view's shout journeys as real-input scenarios in Chrome [N26]. */
import assert from 'node:assert/strict';
import {
  request,
} from 'node:http';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  openSnapshotChrome,
  press,
  chromeExecutable,
  boardOf,
} from '../../../tests/fixtures/cockpit/harness.js';

// ---------------------------------------------------------------------------------------------------------------
// The view's main journeys as Gherkin-style scenarios [N26]. Each step is a Given, When or Then; every When is real
// input: a mouse press at the target's centre through the shared press (which refuses a covered target), typed
// characters and key presses through Chrome's input pipeline. Script only reads the page; it never clicks or sets.

/** The four layouts every scenario walks: a desktop and a phone width, each in the light and the dark scheme. */
const SCENARIO_LAYOUTS = [[1280, 'light'], [375, 'light'], [1280, 'dark'], [375, 'dark']];
/** Each scenario's whole-journey deadline: a hang ceiling for setup, Chrome and four layouts, no speed claim. */
const SCENARIO_DEADLINE_MS = 150_000;

/** A page expression for the first element matching a CSS selector. */
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

/** Type text one character at a time into whatever has focus, as a keyboard does. */
async function typeText(chrome, text) {
  for (const character of text) {
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
  }
}

/** Press one named key into whatever has focus: Enter, or a letter shortcut. */
async function pressKey(chrome, name) {
  const keys = { Enter: ['Enter', 13, '\r'], a: ['KeyA', 65, 'a'], d: ['KeyD', 68, 'd'] };
  const [code, keyCode, text] = keys[name];
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text, unmodifiedText: text });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

/** Put the page at a width and a colour scheme; the fixture keeps reduced motion on through every change. */
async function scenarioLayout(chrome, width, scheme) {
  await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches && matchMedia('(prefers-reduced-motion: reduce)').matches`);
}

/** Open a pane from its tab with a real press, unless it already shows. */
async function openTab(chrome, tab) {
  if (await chrome.stable(`!!document.querySelector('[data-pane=${tab}]') && !document.querySelector('[data-pane=${tab}]').hidden`)) return;
  await press(chrome, q(`[data-tab=${tab}]`));
  await chrome.waitFor(`!document.querySelector('[data-pane=${tab}]').hidden`);
}

/**
 * Declare one journey as "Scenario: <name>". The scenario gets Given/When/Then/And steps whose failures name the step
 * and the layout, an open() that starts the real view and an isolated Chrome under one deadline, and layouts() that
 * walks the journey at 375 and 1280 in light and dark. When the deadline passes, the owned view and Chrome stop.
 */
function scenario(name, play) {
  test(`Scenario: ${name} [N26]`, {
    timeout: SCENARIO_DEADLINE_MS + 30_000, // budget: hang ceiling over the scenario's own deadline, leaving room for owned cleanup.
    skip: !chromeExecutable() && 'Chrome is not installed',
  }, async (t) => {
    const executable = chromeExecutable();
    if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to walk the view journeys.');
    const controller = new AbortController();
    let current = 'Given the scenario starts', layout = '';
    const timer = setTimeout(() => controller.abort(new Error(`Scenario: ${name}: deadline passed during "${current}"`)), SCENARIO_DEADLINE_MS); // budget: hang ceiling for the whole scenario; no speed claim.
    const owned = [];
    const profile = mkdtempSync(join(tmpdir(), 'pullboard-journey-chrome-'));
    let chrome;
    /** One named step: its failure says which step, at which layout. */
    const step = (keyword) => async (text, action) => {
      current = `${keyword} ${text}${layout ? ` (${layout})` : ''}`;
      try { await action(); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        error.message = `${current}: ${error.message}`;
        throw error;
      }
    };
    const steps = {
      Given: step('Given'), When: step('When'), Then: step('Then'), And: step('And'),
      /** Start the real view on a scratch machine and one Chrome on its page. */
      async open(box) {
        const view = await startView(box, { signal: controller.signal, onOwned: (stop) => owned.push(stop) });
        chrome = await openSnapshotChrome(executable, view.link.href, profile, { signal: controller.signal, onOwned: (close) => owned.push(close) });
        await scenarioLayout(chrome, 1280, 'light');
        return { view, chrome };
      },
      /** Walk the journey once in each layout. */
      async layouts(walk) {
        for (const [width, scheme] of SCENARIO_LAYOUTS) {
          layout = `${width}px ${scheme}`;
          await scenarioLayout(chrome, width, scheme);
          await walk({ width, scheme, at: layout });
        }
        layout = '';
      },
    };
    try {
      await play(steps);
      assert.deepEqual(chrome?.exceptions ?? [], [], 'the page raises no uncaught exception');
    } finally {
      clearTimeout(timer);
      const failures = [];
      for (const stop of owned.reverse()) {
        try { await stop(); } catch (error) { failures.push(error.message); }
      }
      rmSync(profile, { recursive: true, force: true });
      if (failures.length) t.diagnostic(`cleanup: ${failures.join('; ')}`);
    }
  });
}

/**
 * The shouts tab ready to read: the board's shouts loaded and one conversation open, since the feed lists
 * conversations first and draws the shout cards only inside the one opened (the shouts without an item are 'none').
 */
async function openShouts(chrome, count, key = 'none') {
  await chrome.waitFor(`typeof data !== 'undefined' && data?.project?.shouts?.length >= ${count}`);
  await openTab(chrome, 'shouts');
  const feed = `[data-pane=shouts]:not([hidden]) #feed`;
  const row = `${feed} [data-shout-thread=${JSON.stringify(key)}]`;
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(`${feed} .conversation-heading, ${row}`)})`);
  if (!(await chrome.stable(`!!document.querySelector(${JSON.stringify(`${feed} .conversation-heading`)})`))) await press(chrome, q(row));
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(`${feed} .shout`)})`);
}

scenario('a long shout folds and stays open across a refresh', async ({ Given, When, Then, And, open, layouts }) => {
  const box = machine();
  const p = project(box, 'fold');
  const long = ['A long note that folds.', ...Array.from({ length: 11 }, (_, n) => `Line ${n + 2} of the note.`)].join('\n');
  box.run(p.web, 'shout', 'all', long);
  const { chrome } = await open(box);
  let id;
  await Given('a twelve-line shout in the feed', async () => {
    await openShouts(chrome, 1);
    id = await chrome.stable(`data.project.shouts.find((s) => s.shout_text.startsWith('A long note')).shout_id`);
  });
  /** The long card's fold control, how many lines its text shows, and whether it is marked open. */
  const folded = () => `JSON.stringify((() => { const c = document.querySelector('#feed #shout-${id}'), t = c.querySelector('.text'); return [c.querySelector('.more').textContent, Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)), c.classList.contains('open')]; })())`;
  await layouts(async ({ at }) => {
    await Given('the long shout is folded at three lines', async () => {
      await chrome.waitFor(`${folded()} === ${JSON.stringify(JSON.stringify(['Show all', 3, false]))}`);
    });
    await When('the person presses Show all', () => press(chrome, q(`#feed #shout-${id} .more`)));
    await Then('every line shows and the control says Show less', () => chrome.waitFor(`${folded()} === ${JSON.stringify(JSON.stringify(['Show less', 12, true]))}`));
    const later = `A later shout at ${at}.`;
    await When('a new shout refreshes the feed', async () => {
      box.run(p.web, 'shout', 'all', later);
      await chrome.waitFor(`[...document.querySelectorAll('#feed .shout .text')].some((node) => node.textContent === ${JSON.stringify(later)})`, 15_000); // budget: hang ceiling for the live refresh to bring the new shout; no throughput claim.
    });
    await Then('the long shout is still open', async () => {
      assert.equal(await chrome.stable(folded()), JSON.stringify(['Show less', 12, true]), 'an open shout stays open across a refresh');
    });
    await When('the person presses Show less', () => press(chrome, q(`#feed #shout-${id} .more`)));
    await And('it folds again at three lines', () => chrome.waitFor(`${folded()} === ${JSON.stringify(JSON.stringify(['Show all', 3, false]))}`));
  });
});

scenario('the person shouts with Enter and sees when the coordinator heard it', async ({ Given, When, Then, And, open, layouts }) => {
  const box = machine();
  const p = project(box, 'heard');
  box.run(p.web, 'shout', 'all', 'Starting on the greeting.');
  const { chrome } = await open(box);
  await Given('the shouts feed', () => openShouts(chrome, 1));
  /** The card with these words in the open conversation: its text, recipient and Heard line. */
  const first = (words) => `JSON.stringify((() => { const c = [...document.querySelectorAll('#feed .shout')].find((card) => card.querySelector('.text').textContent === ${JSON.stringify(words)}); return c && [c.querySelector('.text').textContent, c.querySelector('.to').textContent, c.querySelector('.heard')?.lastChild.textContent ?? null]; })())`;
  await layouts(async ({ at }) => {
    const words = `Ship the greeting at ${at}?`;
    await Given('the composer is addressed to the coordinator', async () => {
      assert.deepEqual(JSON.parse(await chrome.stable(`JSON.stringify([${q('#shout-to')}.value, ${q('#shout-text')}.placeholder, ${q('#shout-to-chip')}.hidden])`)),
        ['coordinator', 'Shout to the coordinator', true]);
    });
    await When('the person types a shout into the message', async () => {
      await press(chrome, q('#shout-text'));
      await chrome.waitFor(`document.activeElement === ${q('#shout-text')}`);
      await typeText(chrome, words);
      assert.equal(await chrome.stable(`${q('#shout-text')}.value`), words, 'the typed words are in the message');
    });
    await And('presses Enter', () => pressKey(chrome, 'Enter'));
    await Then('it is in the feed, to the coordinator, saying Not heard yet', async () => {
      await chrome.waitFor(`${first(words)} === ${JSON.stringify(JSON.stringify([words, '→ coordinator', 'Not heard yet']))} && ${q('#shout-text')}.value === ''`, 15_000); // budget: hang ceiling for the sent shout to be recorded and shown; no throughput claim.
      assert.equal(await chrome.stable(`data.project.shouts.filter((s) => s.shout_from === 'person' && s.shout_to === 'coordinator' && s.shout_text === ${JSON.stringify(words)}).length`), 1, 'Enter sent it once, to the coordinator');
    });
    await When("the coordinator's inbox reads it", () => { box.run(p.repo, 'inbox'); });
    await Then('it says Heard by coordinator', () => chrome.waitFor(`${first(words)} === ${JSON.stringify(JSON.stringify([words, '→ coordinator', 'Heard by coordinator']))}`, 15_000)); // budget: hang ceiling for the inbox read to reach the view; no throughput claim.
  });
});

scenario('picking an agent filters the feed and addresses the composer, and its x returns to the coordinator', async ({ Given, When, Then, And, open, layouts }) => {
  const box = machine();
  const p = project(box, 'pick');
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(p.web, 'claim', '1');
  const second = join(box.dir, 'pick-web-2');
  box.git(p.repo, 'worktree', 'add', '-q', second, '-b', 'web/pick2');
  box.run(second, 'join', 'web');
  box.run(p.web, 'shout', 'all', 'web-1 reports in.');
  box.run(second, 'shout', 'all', 'web-2 reports in.');
  box.run(p.repo, 'shout', 'web-1', 'The coordinator answers web-1.');
  const { chrome } = await open(box);
  await Given('the shouts feed with shouts from several agents', () => openShouts(chrome, 3));
  const total = await chrome.stable('data.project.shouts.length');
  /** The feed's cards as who → whom, its bar, and the composer's address. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify({
    cards: [...document.querySelectorAll('#feed .shout')].map((c) => [c.querySelector('.who').textContent, c.querySelector('.to').textContent]),
    bar: document.querySelector('#feed .feed-bar span')?.textContent ?? '',
    to: ${q('#shout-to')}.value, placeholder: ${q('#shout-text')}.placeholder, chip: ${q('#shout-to-chip')}.hidden ? null : ${q('#shout-to-chip')}.textContent,
  })`));
  await layouts(async () => {
    await Given('the feed shows every shout', async () => {
      const r = await read();
      assert.deepEqual([r.cards.length, r.bar, r.to], [total, '', 'coordinator']);
    });
    await When('the person picks web-1 in the agents panel', () => press(chrome, q('#agents [data-agent="web-1"]')));
    await Then('the feed shows only shouts from or to web-1', async () => {
      await chrome.waitFor(`!!document.querySelector('#feed .feed-bar')`);
      const r = await read();
      assert.ok(r.cards.length > 0 && r.cards.length < total && r.cards.every(([who, to]) => who.startsWith('web-1') || to.includes('web-1')), `only web-1's shouts: ${JSON.stringify(r.cards)}`);
      assert.equal(r.bar, 'Shouts with web-1 (Test Model) show all', 'the bar says whose');
    });
    await And('the composer is addressed to web-1', async () => {
      const r = await read();
      assert.deepEqual([r.to, r.placeholder, r.chip], ['web-1', 'Shout to web-1 (Test Model)', 'to web-1 (Test Model)×']);
    });
    await When("the person presses the chip's x", () => press(chrome, q('#shout-to-chip [data-to-clear]')));
    await Then('the composer returns to the coordinator', async () => {
      await chrome.waitFor(`${q('#shout-to-chip')}.hidden`);
      const r = await read();
      assert.deepEqual([r.to, r.placeholder, r.chip], ['coordinator', 'Shout to the coordinator', null]);
    });
    await When('the person presses show all', () => press(chrome, q('#feed .feed-bar [data-agent=""]')));
    await Then('the feed shows every shout again', async () => {
      await chrome.waitFor(`!document.querySelector('#feed .feed-bar')`);
      const r = await read();
      assert.deepEqual([r.cards.length, r.to], [total, 'coordinator']);
    });
  });
});

scenario('answering a decision moves it out of Decision needed and marks its card answered', async ({ Given, When, Then, And, open, layouts }) => {
  const box = machine();
  const p = project(box, 'decide');
  for (const n of [1, 2, 3, 4]) box.run(p.repo, 'shout', 'person', `Ship option ${n} today?`, '--decision');
  const { chrome } = await open(box);
  await Given('four decisions wait for the person', () => openShouts(chrome, 4));
  await layouts(async ({ at }) => {
    let id;
    await Given('a decision under Decision needed', async () => {
      id = await chrome.stable(`Number(document.querySelector('#feed .shout .answer')?.closest('.shout').id.replace('shout-', ''))`);
      assert.ok(id > 0, 'an ask waits in the feed with its Answer');
      assert.equal(await chrome.stable(`document.querySelector('#feed #shout-${id} .band')?.textContent`), 'Decision needed');
    });
    await When('the person presses its Answer', async () => {
      await press(chrome, q(`#feed #shout-${id} .answer`));
      await chrome.waitFor(`!${q('#answering')}.hidden && document.activeElement === ${q('#shout-text')}`);
    });
    await And('types an answer and presses Enter', async () => {
      await typeText(chrome, `Yes, at ${at}.`);
      await pressKey(chrome, 'Enter');
    });
    await Then('the decision leaves Decision needed', () => chrome.waitFor(`!document.querySelector('#feed #shout-${id} .answer') && data.project.shouts.some((s) => s.shout_answers === ${id} && s.shout_text === ${JSON.stringify(`Yes, at ${at}.`)}) && ${q('#answering')}.hidden`, 15_000)); // budget: hang ceiling for the answer to be recorded and shown; no throughput claim.
    await And('its card in the feed says it is answered', async () => {
      await openShouts(chrome, 4); // the answer returns the feed to its conversations; open this one again
      const band = JSON.parse(await chrome.stable(`JSON.stringify((() => { const b = document.querySelector('#feed #shout-${id} .band'); return b && [b.classList.contains('done'), b.textContent]; })())`));
      assert.ok(band?.[0] && band[1].startsWith('Answered'), `the card's band says answered: ${JSON.stringify(band)}`);
    });
  });
});

scenario('a code reference opens its lines', async ({ Given, When, Then, open, layouts }) => {
  const box = machine();
  const p = project(box, 'refs');
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  writeFileSync(join(p.repo, 'notes.txt'), words.map((word) => `${word} line`).join('\n') + '\n');
  box.git(p.repo, 'add', 'notes.txt');
  box.git(p.repo, 'commit', '-q', '-m', 'docs: notes');
  const head = box.git(p.repo, 'rev-parse', 'HEAD');
  const refs = [1, 2, 3, 4].map((n) => `notes.txt:${n}-${n + 1}@${head}`);
  for (const ref of refs) box.run(p.web, 'shout', 'all', `See ${ref} for the lines.`);
  const { chrome } = await open(box);
  await Given('shouts that name lines of committed code', () => openShouts(chrome, refs.length));
  let n = 0;
  await layouts(async () => {
    const ref = refs[n], from = n + 1;
    n += 1;
    const button = q(`#feed button.ref:not(.block)[data-code="${ref}"]`);
    await Given(`a shout names ${ref.slice(0, ref.indexOf('@'))}`, async () => {
      assert.equal(await chrome.stable(`${button}.getAttribute('aria-expanded')`), 'false', 'the reference starts closed');
    });
    await When('the person presses the reference', () => press(chrome, button));
    await Then('it opens exactly those lines, numbered', async () => {
      const lines = `JSON.stringify([...(${button}.nextElementSibling?.querySelectorAll('.code-wrap .code > span') ?? [])].map((line) => [line.querySelector('i').textContent, line.textContent.slice(line.querySelector('i').textContent.length)]))`;
      const expected = [[String(from), `${words[from - 1]} line`], [String(from + 1), `${words[from]} line`]];
      await chrome.waitFor(`${button}.getAttribute('aria-expanded') === 'true' && ${lines} === ${JSON.stringify(JSON.stringify(expected))}`, 15_000); // budget: hang ceiling for the code request to answer; no throughput claim.
    });
  });
});

scenario('Hide agents survives a reload', async ({ Given, When, Then, And, open, layouts }) => {
  const box = machine();
  const p = project(box, 'hide');
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(p.web, 'claim', '1');
  box.run(p.web, 'shout', 'all', 'web-1 reports in.');
  const { chrome } = await open(box);
  await Given('the shouts feed beside the agents panel', () => openShouts(chrome, 1));
  /** Whether the panel shows, whether the pane is bare, and what the toggle in the composer's line says. */
  const panel = `JSON.stringify([document.querySelector('#agents').offsetParent !== null, document.querySelector('#shouts-pane').classList.contains('bare'), document.querySelector('.asks-slot [data-agents-toggle]')?.textContent ?? null])`;
  await layouts(async () => {
    await Given('the agents panel shows', () => chrome.waitFor(`${panel} === ${JSON.stringify(JSON.stringify([true, false, null]))}`));
    await When('the person presses Hide agents', () => press(chrome, q('.panel-head [data-agents-toggle]')));
    await Then('the panel hides and Show agents offers it back', () => chrome.waitFor(`${panel} === ${JSON.stringify(JSON.stringify([false, true, 'Show agents']))}`));
    await When('the page reloads', async () => {
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await chrome.waitFor(`performance.timeOrigin !== ${before} && document.readyState === 'complete' && typeof data !== 'undefined' && data?.project?.shouts?.length >= 1`, 15_000); // budget: hang ceiling for the reloaded page's first board state; no throughput claim.
      await openShouts(chrome, 1);
    });
    await Then('the panel is still hidden', () => chrome.waitFor(`${panel} === ${JSON.stringify(JSON.stringify([false, true, 'Show agents']))}`));
    await When('the person presses Show agents', () => press(chrome, q('.asks-slot [data-agents-toggle]')));
    await And('the panel shows again', () => chrome.waitFor(`${panel} === ${JSON.stringify(JSON.stringify([true, false, null]))}`));
  });
});

scenario('on Spec, A approves the picked draft and picks the next, and D asks why', async ({ Given, When, Then, And, open, layouts }) => {
  const drafts = ['The page names its owner.', 'Every list says when it was read.', 'A failed save says why.', 'Dates say which day they were.',
    'Long titles end in an ellipsis.', 'The theme follows the system.', 'Each tab keeps its place.', 'Empty lists say how to start.', 'Errors name a next step.'];
  const spec = '# Decisions\n\n## S · Screens\n' + drafts.map((words, n) => `- S${n + 1} [draft, must] ${words} | gate: review\n`).join('');
  const box = machine();
  const p = project(box, 'spec-keys', spec);
  const { view, chrome } = await open(box);
  /** A Spec row as the board records it: its stage and its decision's reason, or approved. */
  const recorded = async (id) => {
    const row = (await boardOf(view, p.repo)).spec.find((entry) => entry.id === id);
    return { stage: row?.stage || row?.status || null, decided: row?.decision ? (row.decision.reason || 'approved') : null };
  };
  await Given('drafts wait under Needs your decision on Spec', async () => {
    await chrome.waitFor("typeof data === 'object' && data?.project?.spec?.length === 9");
    await openTab(chrome, 'spec');
    await chrome.waitFor(`!!document.querySelector('#spec-list .srow')`);
  });
  await layouts(async ({ at }) => {
    let first, next;
    await Given('the first draft in the list', async () => {
      [first, next] = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#spec-list .srow')].map((row) => row.dataset.row.slice(5)))`));
      assert.ok(first && next, 'two drafts wait');
    });
    await When('the person clicks it', async () => {
      await press(chrome, q(`#spec-list [data-row="spec:${first}"]`));
      await chrome.waitFor(`view.row.spec === '${first}' && document.activeElement === ${q('#spec-list')}`);
    });
    await And('presses A', () => pressKey(chrome, 'a'));
    await Then('it is approved and the next draft is picked', async () => {
      await chrome.waitFor(`!document.querySelector('#spec-list [data-row="spec:${first}"]') && view.row.spec === '${next}' && document.activeElement === ${q('#spec-list')}`, 15_000); // budget: hang ceiling for the saved approval and the next pick; no throughput claim.
      assert.deepEqual([await recorded(first), await recorded(next)], [{ stage: 'approved, pending apply', decided: 'approved' }, { stage: 'draft', decided: null }], `A approved ${first}, and only ${first}`);
    });
    await When('the person presses D', () => pressKey(chrome, 'd'));
    await Then('it asks why the next draft is declined', () => chrome.waitFor(`!${q('#spec-decline-dialog')}.hidden && ${q('#spec-decline-title')}.textContent === 'Decline ${next}' && document.activeElement === ${q('#spec-decline-reason')}`));
    await When('the person types why and presses Enter', async () => {
      await typeText(chrome, `unclear at ${at}`);
      await pressKey(chrome, 'Enter');
    });
    await Then('the draft is declined with that reason', async () => {
      await chrome.waitFor(`${q('#spec-decline-dialog')}.hidden && !document.querySelector('#spec-list [data-row="spec:${next}"]')`, 15_000); // budget: hang ceiling for the saved decline to leave the list; no throughput claim.
      assert.deepEqual(await recorded(next), { stage: 'declined, pending apply', decided: `unclear at ${at}` });
    });
  });
});
