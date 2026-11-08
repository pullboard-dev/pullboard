// pullboard: browser
/** @pullboard-test-gui */
/** Newcomer journeys use a fresh init and the actual retained tour board [N26]. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

/** Initialize the real template, retaining its spec and doctrine instead of replacing them with demo rows. */
function freshProject(box) {
  const repo = join(box.dir, 'fresh-project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const env = { ...box.env };
  delete env.PULLBOARD_MODEL;
  box.runWithEnv(repo, env, 'init');
  const file = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'true';
  config.lanes = { review: { owns: [] }, research: { owns: [] }, web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize newcomer fixture');
  return repo;
}

/** Visit one tab through the same pointer path as a person. */
async function tab(chrome, name) {
  await press(chrome, `document.querySelector('[data-tab="${name}"]')`);
  await chrome.waitFor(`!document.querySelector('[data-pane="${name}"]').hidden`);
}

// Budget: two real Chrome viewport journeys, including local source-file refreshes; a hang ceiling, not a speed claim.
test('a new project reviews inherited defaults and files new work in its first building lane [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the newcomer journey');
  const box = machine();
  const repo = freshProject(box);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-newcomer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.practice?.some(row => row.origin === "standard" && row.status === "pending")');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await tab(chrome, 'doctrine');
      await press(chrome, 'document.querySelector("#doctrine-chips [data-rows=\\"doctrine:decide\\"]")');
      assert.equal(await chrome.stable('document.querySelector("#doctrine-chips [data-rows=\\"doctrine:decide\\"] b").textContent'), '0', `${width}: untouched template rules are not decisions waiting`);
      assert.equal(await chrome.stable('document.querySelectorAll("#doctrine-list .srow").length'), 0, `${width}: no inherited rule appears among the person\'s calls`);
      const defaults = await chrome.stable('document.querySelector("#doctrine-chips [data-rows=\\"doctrine:defaults\\"]")?.textContent');
      assert.match(defaults ?? '', /^To review\d+$/, `${width}: inherited rules have the shorter To review label`);
      await press(chrome, 'document.querySelector("#doctrine-chips [data-rows=\\"doctrine:defaults\\"]")');
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#doctrine-list .srow")].map(row => row.dataset.row.slice(9)))')),
        JSON.parse(await chrome.stable('JSON.stringify(data.project.practice.filter(row => row.origin === "standard").map(row => row.id))')), `${width}: every inherited default remains available to review`);
      await press(chrome, 'document.querySelector("#doctrine-list [data-row=\\"doctrine:PB7\\"]")');
      assert.match(await chrome.stable('document.querySelector("#doctrine-detail").textContent'), /Approve it to keep it, or override or decline it in DOCTRINE\.md/, `${width}: the default explains how to adopt a local rule`);
      assert.equal(await chrome.stable('document.querySelectorAll("#doctrine-detail [data-row-decision]").length'), 0, `${width}: inherited defaults offer no local decision action`);
      await tab(chrome, 'items');
      await press(chrome, 'document.querySelector("#new-item")');
      assert.equal(await chrome.stable('document.querySelector("#add-lane").value'), 'web', `${width}: new work starts in the first lane owning folders`);
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelector("#add-lane").options].map(option => option.value))')),
        ['web', 'api', 'coordinator', 'review', 'research'], `${width}: building lanes precede coordinator and non-building lanes`);
    }

    appendFileSync(join(repo, 'DOCTRINE.md'), '\n## Local proposals\n- R1 [draft, must] Review the team\'s proposed rule. | gate: review\n- R2 [pending, aim] Should the team keep this local rule? | gate: review\n');
    appendFileSync(join(repo, 'SPEC.md'), '\n- G1 [pending, must] Should the project greet a visitor? | gate: review\n');
    await chrome.waitFor('data.project.practice.some(row => row.id === "R2") && data.project.spec.some(row => row.id === "G1")');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await tab(chrome, 'doctrine');
      await press(chrome, 'document.querySelector("#doctrine-chips [data-rows=\\"doctrine:decide\\"]")');
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#doctrine-list .srow")].map(row => row.dataset.row.slice(9)))')), ['R1', 'R2'], `${width}: local drafts and pending rules remain real decisions`);
      await tab(chrome, 'spec');
      await press(chrome, 'document.querySelector("#spec-chips [data-rows=\\"spec:decide\\"]")');
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#spec-list .srow")].map(row => row.dataset.row.slice(5)))')), ['G1'], `${width}: the repo\'s open spec question still waits for the person`);
      assert.ok(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), `${width}: the newcomer filters fit without sideways scrolling`);
    }
    assert.deepEqual(chrome.exceptions, [], 'the newcomer journey raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

// Budget: the real scripted tour and two Chrome viewport journeys; a hang ceiling, not a speed claim.
test('the actual tour leaves a labelled demo visible at phone and desktop widths [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the retained tour board');
  const box = machine();
  const env = { ...box.env, TMPDIR: box.dir };
  delete env.PULLBOARD_MODEL;
  const output = box.runWithEnv(box.dir, env, 'tour');
  assert.equal(output.trimEnd().split('\n').at(-1), 'see it: pullboard view', 'the actual tour ends with the view command');
  const demo = /Look around: cd (.+) && pullboard log/.exec(output)?.[1];
  assert.ok(demo, 'the tour prints its retained real repo');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-tour-newcomer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(demo)}`);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      assert.ok(await chrome.stable(`[...document.querySelectorAll('#proj-list [data-root]')].some(row => row.dataset.root === ${JSON.stringify(demo)} && /demo/.test(row.textContent))`), `${width}: the real tour board is listed and marked demo`);
      assert.equal(await chrome.stable('document.querySelector("#proj-name").textContent'), 'demo', `${width}: the selected board is the registered tour demo`);
      assert.ok(await chrome.stable('data.project.items.some(item => item.status === "verified" && item.stage === "merged")'), `${width}: the tour\'s actual accepted history is visible`);
      await tab(chrome, 'items');
      await press(chrome, 'document.querySelector("#new-item")');
      assert.equal(await chrome.stable('document.querySelector("#add-lane").value'), 'app', `${width}: tour work also defaults to its building lane`);
      await press(chrome, 'document.querySelector("#add-cancel")');
    }
    assert.deepEqual(chrome.exceptions, [], 'the retained tour raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
