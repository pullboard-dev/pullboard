// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit search checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, searchFor, press, allowLiveHold, holdLive } from './fixture.js';

/** Copy Node into a path with spaces so executable wrappers exercise the path they cannot put in a shebang. */
function nodeWithSpaces(root) {
  const folder = join(root, 'node with spaces');
  mkdirSync(folder, { recursive: true });
  const node = join(folder, 'node');
  copyFileSync(realpathSync(process.execPath), node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o700);
  return node;
}

/** Quote one POSIX shell word so fixture paths preserve spaces and shell metacharacters. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Capture the current search page and its last real board-state request without exposing the session key. */
async function searchSetupState(chrome) {
  const caughtAt = new Date().toISOString();
  const requests = chrome.requests.filter(({ method, url }) => {
    let path;
    try { path = new URL(url).pathname; } catch { return false; }
    return method === 'GET' && /^\/api\/v1\/boards\/[^/]+\/state$/.test(path);
  });
  const last = requests.at(-1);
  let page = null, captureError = null;
  try {
    page = JSON.parse(await chrome.stable(`JSON.stringify({
      project: typeof data === 'object' && data?.project ? { root: data.project.root, name: data.project.name ?? null } : null,
      itemCount: typeof data === 'object' && Array.isArray(data?.project?.items) ? data.project.items.length : null
    })`));
  } catch (error) {
    captureError = `${error.name}: ${error.message}`;
  }
  return {
    caughtAt,
    pageObservedAt: new Date().toISOString(),
    project: page?.project ?? null,
    itemCount: page?.itemCount ?? null,
    lastStateRequest: last ? { method: last.method, path: new URL(last.url).pathname } : null,
    captureError,
    rootCauseStatus: 'NOT PROVEN',
  };
}

/** Commit between actual Git reads, preserving each real command's output and exit status. */
function interleavedAges(file, when) {
  const box = machine();
  const g3 = '- G3 [approved, must] The greeting names the visitor. | gate: web test\n';
  const g4 = '- G4 [approved, must] The greeting waves back. | gate: web test\n';
  const g5 = '- G5 [approved, must] The greeting fits a phone. | gate: web test\n';
  const r1 = '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n';
  const r2 = '- R2 [approved, must] A greeting never shouts. | gate: review\n';
  const alpha = project(box, 'pinned-ages', SPEC + g3, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), r1);
  writeFileSync(join(alpha.repo, 'SPEC.md'), SPEC + g3 + g4);
  box.git(alpha.repo, 'add', 'ways.md', 'SPEC.md');
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs(spec): add the second greeting [G1]');
  const specTarget = file === 'SPEC.md';
  writeFileSync(join(alpha.repo, specTarget ? 'ways.md' : 'SPEC.md'), specTarget ? r1 + r2 : SPEC + g5 + g3 + g4);
  box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): add the next greeting [G1]');
  const captured = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const future = join(box.dir, 'next-row.txt'), receipt = join(box.dir, 'interleave.json');
  writeFileSync(future, specTarget ? SPEC + g5 + g3 + g4 : r1 + r2);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(box.dir, 'bin', 'git');
  const program = join(box.dir, 'bin', 'git-wrapper.mjs');
  writeFileSync(program, `
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), file = ${JSON.stringify(file)}, receipt = ${JSON.stringify(receipt)};
const realGit = ${JSON.stringify(realGit)};
/** Run the real Git command with unchanged arguments and environment. */
const run = (words) => spawnSync(realGit, words, { encoding: 'utf8', env: process.env });
const interleave = args[0] === 'log' && args.includes('--format=%H') && args.at(-1) === file && !existsSync(receipt);
let before, after, result;
/** Add the prepared real row in a real commit, without changing any command response. */
function advance() {
  writeFileSync(file, readFileSync(${JSON.stringify(future)}));
  for (const words of [['add', file], ['commit', '-q', '-m', 'docs(spec): interleave a greeting [G1]']]) {
    const step = run(words);
    if (step.status !== 0) throw new Error(step.stderr);
  }
  after = run(['rev-parse', 'HEAD']).stdout.trim();
}
if (interleave) {
  before = run(['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(receipt, '{}');
  if (${JSON.stringify(when)} === 'before') advance();
  result = run(args);
  if (${JSON.stringify(when)} === 'after') advance();
  writeFileSync(receipt, JSON.stringify({ args, before, after, status: result.status, stdout: result.stdout }));
} else result = run(args);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exitCode = result.status ?? 1;
`);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  // Both tabs may read the on-disk row before its commit lands between their history reads.
  writeFileSync(join(alpha.repo, file), readFileSync(future));
  const worker = spawnSync(process.execPath, ['--input-type=module', '-e', `import { projectState } from ${JSON.stringify(new URL('../../apps/cli/src/shell/cli/view-state.js', import.meta.url).href)}; console.log(JSON.stringify(projectState(${JSON.stringify(alpha.repo)})));`], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
  assert.equal(worker.status, 0, `real projectState child: ${worker.stderr}`);
  const state = JSON.parse(worker.stdout), observed = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const proof = JSON.parse(readFileSync(receipt, 'utf8'));
  const ordinals = { spec: state.spec.map(({ id, added }) => ({ id, added })), doctrine: state.practice.map(({ id, added }) => ({ id, added })) };
  return { state, captured, observed, proof, ordinals };
}

/** Pin every age read despite a real commit before or after either file's ordinal log. */
test('row ages read from one captured commit [N26]', () => {
  for (const file of ['SPEC.md', 'ways.md']) for (const when of ['after', 'before']) {
    const { state, captured, observed, proof, ordinals } = interleavedAges(file, when);
    const diagnostic = JSON.stringify({ file, when, ordinals, captured, observed, computedAt: state.rowAgesAt ?? null, proof });
    assert.notEqual(observed, captured, diagnostic);
    assert.equal(proof.before, captured, diagnostic);
    assert.equal(proof.after, observed, diagnostic);
    assert.equal(proof.status, 0, diagnostic);
    /** Keep only the deliberate fixture rows, in the same age order as search results. */
    const ordered = (rows, ids) => rows.filter((row) => ids.includes(row.id)).sort((a, b) => a.added - b.added).map(({ id, added }) => [id, added]);
    const spec = ordered(state.spec, ['G3', 'G4', 'G5']), doctrine = ordered(state.practice, ['R1', 'R2']);
    assert.deepEqual(spec.map(([id]) => id), ['G5', 'G4', 'G3'], diagnostic);
    assert.deepEqual(doctrine.map(([id]) => id), ['R2', 'R1'], diagnostic);
    assert.deepEqual(spec, file === 'SPEC.md' ? [['G5', 0], ['G4', 1], ['G3', 2]] : [['G5', 1], ['G4', 2], ['G3', 3]], diagnostic);
    assert.deepEqual(doctrine, file === 'SPEC.md' ? [['R2', 1], ['R1', 2]] : [['R2', 0], ['R1', 1]], diagnostic);
    assert.deepEqual(state.rowAgesAt, { 'SPEC.md': captured, 'ways.md': captured }, diagnostic);
  }
});

test('search wrappers run when Node lives at a path with spaces [C7]', { timeout: 480_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-search-spaced-node-'));
  try {
    const node = nodeWithSpaces(root);
    const pattern = 'row ages read from one captured commit|spec rows keep newest-first order across a capture that moves';
    const args = ['--test', '--test-reporter=tap', '--test-name-pattern', pattern, 'test/cockpit/search.test.js'];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = spawnSync(node, args, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 150_000 });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.equal(result.status, 0, `spaced Node run ${attempt}/3 failed: ${output}`);
      assert.match(output, /^ok \d+ - row ages read from one captured commit \[N26\]$/m, `spaced Node run ${attempt}/3 omitted row-age case`);
      assert.match(output, /^ok \d+ - spec rows keep newest-first order across a capture that moves \[N26\]$/m, `spaced Node run ${attempt}/3 omitted moving-capture case`);
      assert.match(output, /^# pass 2$/m, `spaced Node run ${attempt}/3 did not complete both cases`);
      assert.doesNotMatch(output, /# SKIP\b/, `spaced Node run ${attempt}/3 skipped a case`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/** Wait for committed row order, rather than rows that may already be visible as uncommitted edits. */
async function committedRows(chrome, head) {
  await chrome.waitFor(`data?.project?.rowAgesAt?.['SPEC.md'] === ${JSON.stringify(head)} && data.project.rowAgesAt['ways.md'] === ${JSON.stringify(head)}`, 15_000); // budget: hang ceiling for the committed row-age snapshot to arrive; no throughput claim.
}

/** Observe the old and refreshed captures around real commits without replacing any Git or HTTP response. */
test('spec rows keep newest-first order across a capture that moves [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the moving-capture proof');
  const box = machine();
  const g3 = '- G3 [approved, must] The greeting names the visitor. | gate: web test\n';
  const g4 = '- G4 [approved, must] The greeting waves back. | gate: web test\n';
  const g5 = '- G5 [approved, must] The greeting fits a phone. | gate: web test\n';
  const r1 = '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n';
  const r2 = '- R2 [approved, must] A greeting never shouts. | gate: review\n';
  const alpha = project(box, 'moving-capture', SPEC + g3, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), r1);
  box.git(alpha.repo, 'add', 'ways.md');
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs(rules): keep the local rules [G1]');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const armed = join(box.dir, 'armed'), receipt = join(box.dir, 'moved.json');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moving-capture-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Keep this controlled observation until an explicit real refresh; no API response is substituted. The view's own
    // live updates (the stream's catch-up, the fallback read) wait from the moment the board is ready (#622).
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    await holdLive(chrome, "data?.project?.spec.some(row => row.id === 'G3') && data.project.practice.some(row => row.id === 'R1')");
    // A new HEAD invalidates the age cache; R2 is already a visible working edit, as in the CI shape.
    writeFileSync(join(alpha.repo, 'ways.md'), r1 + r2);
    writeFileSync(join(alpha.repo, 'capture.txt'), 'The next state captures this commit.\n');
    box.git(alpha.repo, 'add', 'capture.txt');
    box.git(alpha.repo, 'commit', '-q', '-m', 'test(view): advance the capture [G1]');
    const captured = box.git(alpha.repo, 'rev-parse', 'HEAD');
    const wrapper = join(box.dir, 'bin', 'git');
    const program = join(box.dir, 'bin', 'git-wrapper.mjs');
    writeFileSync(program, `
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), realGit = ${JSON.stringify(realGit)};
/** Run actual Git unchanged, including its original captured revision. */
const run = words => spawnSync(realGit, words, { encoding: 'utf8', env: process.env });
if (args[0] === 'log' && args.includes('--format=%H') && args.at(-1) === 'SPEC.md' && existsSync(${JSON.stringify(armed)})) {
  unlinkSync(${JSON.stringify(armed)});
  const before = run(['rev-parse', 'HEAD']).stdout.trim();
  const steps = [];
  for (const spec of [${JSON.stringify(SPEC + g3 + g4)}, ${JSON.stringify(SPEC + g5 + g3 + g4)}]) {
    writeFileSync('SPEC.md', spec);
    for (const words of [['add', 'SPEC.md', 'ways.md'], ['commit', '-q', '-m', 'docs(spec): add the next greeting [G1]']]) {
      const step = run(words); if (step.status !== 0) throw new Error(step.stderr);
    }
    steps.push(run(['rev-parse', 'HEAD']).stdout.trim());
  }
  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ before, after: steps.at(-1), steps, args }));
}
const result = run(args);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exitCode = result.status ?? 1;
`);
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(armed, 'capture');
    await chrome.stable('refresh()');
    const proof = JSON.parse(readFileSync(receipt, 'utf8'));
    const observed = box.git(alpha.repo, 'rev-parse', 'HEAD');
    /** Read capture refs, exact ages and rendered search order together at one browser boundary. */
    const observe = () => chrome.stable(`(() => {
      showFound();
      return { captured: data.project.rowAgesAt,
        spec: data.project.spec.filter(row => ['G3','G4','G5'].includes(row.id)).map(({id,added}) => ({id,added})),
        doctrine: data.project.practice.filter(row => ['R1','R2'].includes(row.id)).map(({id,added}) => ({id,added})),
        order: [...document.querySelectorAll('#find-results [data-find]')].filter(hit => /^(spec|doctrine):/.test(hit.dataset.find)).map(hit => hit.querySelector('code').textContent) };
    })()`);
    await searchFor(chrome, 'greeting');
    const early = await observe();
    const diagnostic = JSON.stringify({ captured, observed, proof, early });
    assert.equal(proof.before, captured, diagnostic);
    assert.equal(proof.after, observed, diagnostic);
    assert.notEqual(captured, observed, diagnostic);
    assert.deepEqual(early.captured, { 'SPEC.md': captured, 'ways.md': captured }, diagnostic);
    assert.deepEqual(early.spec.filter(row => ['G4','G5'].includes(row.id)).map(row => row.added), [0, 0], diagnostic);
    assert.ok(early.doctrine.some(row => row.id === 'R2'), 'the former presence-only readiness condition is already satisfied');
    assert.deepEqual(early.order, ['G4', 'G5', 'G3', 'R2', 'R1'], diagnostic);
    // Start the actual comparison while the stale capture is still visible. Presence-only readiness
    // would resolve now and preserve that wrong order, even though a later refresh becomes correct.
    const comparison = committedRows(chrome, observed).then(observe);
    // Two ordered browser observations let the readiness check and any early comparison finish,
    // without a wall-clock sleep or changing the real response. Both still see the held capture.
    for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
      assert.deepEqual((await observe()).captured, early.captured, 'the real stale capture remains visible before the refresh');
    }
    // Only the committed-head barrier keeps the comparison pending until this real refresh.
    await chrome.stable('refresh()');
    const latest = await comparison;
    assert.deepEqual(latest.captured, { 'SPEC.md': observed, 'ways.md': observed }, JSON.stringify(latest));
    assert.deepEqual(latest.spec.map(row => [row.id,row.added]), [['G5',1],['G3',3],['G4',2]], JSON.stringify(latest));
    assert.deepEqual(latest.order, ['G5', 'G4', 'G3', 'R2', 'R1'], JSON.stringify(latest));
    t.diagnostic(JSON.stringify({ captured, observed, proof, early, latest }));
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});


test('search in the top bar finds anything on the board [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [approved, must] The greeting names the visitor. | gate: web test\n`;
  const alpha = project(box, 'finder', spec, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n');
  box.run(alpha.repo, 'add', 'web', 'Farewell page', '--specs', 'G1', '--criterion', 'renders');
  // Seven items match, so the Items group shows five of them and says how many there are.
  for (let n = 1; n <= 7; n += 1) box.run(alpha.repo, 'add', 'web', `Greeting variant ${n}`, '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.web, 'shout', 'all', 'The greeting is ready for review.');
  box.run(alpha.web, 'shout', 'coordinator', 'Should the greeting wave?', '--decision', '--kind', 'question');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-finder-chrome-'));
  let chrome;
  /** The top bar's search and its results as they read. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const results = document.querySelector('#find-results');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      inTop: !!document.querySelector('.top .top-find #q'), toolbar: [...document.querySelector('.toolbar').children].filter((e) => e.offsetParent !== null).map((e) => e.id || e.className),
      field: box(document.querySelector('#q')), tabs: box(document.querySelector('#tabs')), top: box(document.querySelector('header.top')), theme: box(document.querySelector('#theme')),
      bar: [...document.querySelectorAll('.toolbar .items-view-switch button, .toolbar #filter-toggle, .toolbar #new-item')].filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ name: e.dataset.itemsView || e.id, on: e.getAttribute('aria-pressed') === 'true', middle: Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2) })),
      filterLabel: document.querySelector('#filter-toggle').textContent,
      shoutIds: data.project.shouts.map((x) => '#' + x.shout_id), focused: document.activeElement?.id ?? null, value: document.querySelector('#q').value,
      shown: !results.hidden, groups: [...results.querySelectorAll('h4')].map((h) => [h.firstChild.textContent, h.querySelector('span').textContent]),
      hits: [...results.querySelectorAll('.find-hit')].map((hit) => ({ go: hit.dataset.find, id: hit.querySelector('code').textContent, note: hit.querySelector('small').textContent, on: hit.classList.contains('on') })),
      tab: view.tab, item: view.item, spec: view.row.spec, doctrine: view.row.doctrine,
    };
  })())`));
  const key = async (name, code, keyCode, text) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
  };
  const tap = async (selector) => {
    await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  };
  /** Select a menu choice through the browser's input path. */
  const chooseFilter = async (kind, value) => {
    await tap('#filter-toggle');
    await tap(`[data-filter-choice="${kind}:${value}"]`);
  };
  const search = (words) => searchFor(chrome, words);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 8 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await chrome.click("document.querySelector('[data-tab=items]')");
        const at = `${width}px ${scheme}`;
        // The Items toolbar is one row: view toggle, Filter and New item.
        const bar = (await read()).bar, names = bar.map((part) => part.name);
        assert.deepEqual(names, ['list', 'pipeline', 'filter-toggle', 'new-item'], `${at}: view toggle, Filter and New item share the toolbar`);
        assert.ok(bar.every((part) => Math.abs(part.middle - bar[0].middle) <= 2), `${at}: the toolbar is one row: ${JSON.stringify(bar)}`);
        await search('greeting');
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // The search is the top bar's; the Items toolbar keeps its view, filter and New item controls.
        assert.ok(r.inTop, `${at}: the search sits in the top bar`);
        assert.deepEqual(r.toolbar, ['items-view-switch', 'filter-control', 'new-item'], `${at}: the Items toolbar has no search field`);
        if (width === 375) assert.ok(r.field.top >= r.tabs.bottom - 1 && r.field.width >= r.page.width - 40, `${at}: on a phone the search is its own row under the tabs: ${JSON.stringify([r.field, r.tabs])}`);
        else assert.ok(Math.abs((r.field.top + r.field.height / 2) - (r.top.top + r.top.height / 2)) <= 2 && r.field.left >= r.tabs.right && r.field.right <= r.theme.left, `${at}: the search sits in the top bar between the tabs and the theme button: ${JSON.stringify([r.tabs, r.field, r.theme, r.top])}`);
        // Results group by kind, five a group with how many there are, the first ready for Enter.
        assert.deepEqual(r.groups, [['Items', '5 of 7'], ['Spec', '1'], ['Doctrine', '1'], ['Shouts', '2']], `${at}: grouped, newest first, five a group`);
        assert.deepEqual([r.hits.length, r.hits.findIndex((hit) => hit.on), r.hits.slice(5).map((hit) => hit.id)], [9, 0, ['G3', 'R1', ...r.shoutIds]], `${at}: every group's results, the first highlighted`);
        // A shout's result is its own id, its words and its kind, newest first.
        assert.deepEqual(r.hits.slice(7).map((hit) => hit.note), ['decision', 'shout'], `${at}: a shout's result names its kind: ${JSON.stringify(r.hits.slice(7))}`);
        await key('Escape', 'Escape', 27);
        const cleared = await read();
        assert.deepEqual([cleared.value, cleared.shown], ['', false], `${at}: Esc clears the search and closes its results`);
      }
    }

    // A search begun straight after Esc keeps its results: leaving the field closes them a moment later, and coming back
    // before then must not let that close take the new ones (CI lost them this way between searches, #394).
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await search('greeting');
    await key('Escape', 'Escape', 27);
    await search('greeting');
    await chrome.stable('new Promise((done) => setTimeout(done, 250))');
    const kept = JSON.parse(await chrome.stable("JSON.stringify([document.querySelector('#q').value, document.activeElement.id, document.querySelector('#find-results').hidden])"));
    assert.deepEqual(kept, ['greeting', 'q', false], `a search straight after Esc keeps its results (words, focus, results hidden): ${JSON.stringify(kept)}`);
    await key('Escape', 'Escape', 27);
    assert.equal(await chrome.stable("document.querySelector('#find-results').dataset.why"), 'escape', 'Esc closes the results and says so');

    // The arrows move the highlight and Enter opens it: here the third item, the third newest.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await search('greeting');
    let r = await read();
    const third = r.hits[2].go;
    await key('ArrowDown', 'ArrowDown', 40);
    await key('ArrowDown', 'ArrowDown', 40);
    assert.equal((await read()).hits.findIndex((hit) => hit.on), 2, 'down twice highlights the third');
    await key('ArrowUp', 'ArrowUp', 38);
    await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13, '\r');
    await chrome.waitFor(`view.tab === 'items' && view.item === ${Number(third.slice(5))} && document.querySelector('#find-results').hidden`);

    // On a phone, a search that opens an item names the selected All filter, which can be changed back to Active.
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 375 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && document.querySelector('#find-results').hidden");
      const opened = await read();
      assert.equal(opened.filterLabel, 'Filter: All', `375px ${scheme}: a search that opens an item names All`);
      assert.deepEqual(opened.bar.map((part) => part.name), ['list', 'pipeline', 'filter-toggle', 'new-item'], `375px ${scheme}: the toolbar retains its controls: ${JSON.stringify(opened.bar)}`);
      assert.ok(opened.bar.every((part) => Math.abs(part.middle - opened.bar[0].middle) <= 2), `375px ${scheme}: still one row: ${JSON.stringify(opened)}`);
      await chooseFilter('state', 'active');
      assert.equal((await read()).filterLabel, 'Filter', `375px ${scheme}: back on Active, All is cleared`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');

    // Spec rows and Doctrine rules read newest first by when each was added, not by where it sits in its file: R1 is
    // committed, then R2 and G4 appended, then G5 inserted above G3.
    box.git(alpha.repo, 'add', 'ways.md');
    box.git(alpha.repo, 'commit', '-q', '-m', 'docs(rules): keep the local rules [G1]');
    writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n- R2 [approved, must] A greeting never shouts. | gate: review\n');
    writeFileSync(join(alpha.repo, 'SPEC.md'), `${spec}- G4 [approved, must] The greeting waves back. | gate: web test\n`);
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting waves back [G1]');
    writeFileSync(join(alpha.repo, 'SPEC.md'), spec.replace('- G3 ', '- G5 [approved, must] The greeting fits a phone. | gate: web test\n- G3 ') + '- G4 [approved, must] The greeting waves back. | gate: web test\n');
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting fits a phone [G1]');
    // The working file can expose G5 before its commit: compare only after the page captures the completed commit.
    await committedRows(chrome, box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await search('greeting');
    const added = (await read()).hits.filter((hit) => /^(spec|doctrine):/.test(hit.go)).map((hit) => hit.id);
    const ageProof = JSON.parse(await chrome.stable('JSON.stringify({ captured: data.project.rowAgesAt ?? null, spec: data.project.spec.map(({ id, added }) => ({ id, added })), doctrine: data.project.practice.map(({ id, added }) => ({ id, added })) })'));
    assert.deepEqual(added, ['G5', 'G4', 'G3', 'R2', 'R1'], `Spec and Doctrine newest first by when each row was added: ${JSON.stringify({ added, ...ageProof, observed: box.git(alpha.repo, 'rev-parse', 'HEAD') })}`);
    await key('Escape', 'Escape', 27);

    // A click opens a Spec row, a Doctrine rule or a shout where it lives.
    await search('greeting');
    await tap('#find-results [data-find="spec:G3"]');
    await chrome.waitFor("view.tab === 'spec' && view.row.spec === 'G3' && document.querySelector('#spec-detail h2 span')?.textContent === 'G3'");
    await search('greeting');
    await tap('#find-results [data-find="doctrine:R1"]');
    await chrome.waitFor("view.tab === 'doctrine' && view.row.doctrine === 'R1' && document.querySelector('#doctrine-detail h2 span')?.textContent === 'R1'");
    await search('greeting');
    const shout = (await read()).hits.find((hit) => hit.go.startsWith('shout:')).go;
    await tap(`#find-results [data-find="${shout}"]`);
    await chrome.waitFor(`view.tab === 'shouts' && document.getElementById('shout-${shout.slice(6)}')?.classList.contains('found')`);

    // "/" goes to the search from the page, never from a field.
    await chrome.stable("document.activeElement.blur(); document.body.focus()");
    await key('/', 'Slash', 191, '/');
    r = await read();
    const selected = await chrome.stable("(() => { const q = document.querySelector('#q'); return q.selectionStart === 0 && q.selectionEnd === q.value.length; })()");
    assert.deepEqual([r.focused, selected], ['q', true], '"/" puts the cursor in the search, its last words selected to type over');
    await chrome.stable("document.querySelector('#shout-text').focus()");
    await key('/', 'Slash', 191, '/');
    assert.equal(await chrome.stable("document.querySelector('#shout-text').value"), '/', 'and in a field it is only a slash');

    // On a phone the lane picker shows while a lane narrows the list, so the person sees where they are and can leave
    // it; with every lane shown it drops again. A coordinator item makes a second lane to pick between.
    box.run(alpha.repo, 'add', 'coordinator', 'Plan the greeting release', '--criterion', 'planned');
    await chrome.waitFor('data.project.items.length === 9', 15_000);
    /** Pick a lane through the visible filter menu. */
    const lane = async (name) => {
      await press(chrome, "document.querySelector('#filter-toggle')");
      await press(chrome, `document.querySelector('[data-filter-choice="lane:${name}"]')`);
    };
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 1280 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await chrome.click("document.querySelector('[data-tab=items]')"); await chooseFilter('state', 'active');
      await lane('web');
      await chrome.waitFor("view.lane === 'web'");
      assert.equal((await read()).filterLabel, 'Filter: web', `1280px ${scheme}: the selected lane is named by Filter`);
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === 375');
      const narrowed = await read();
      assert.deepEqual(narrowed.bar.map((part) => part.name), ['list', 'pipeline', 'filter-toggle', 'new-item'], `375px ${scheme}: a picked lane keeps all toolbar controls: ${JSON.stringify(narrowed.bar)}`);
      assert.ok(narrowed.bar.every((part) => Math.abs(part.middle - narrowed.bar[0].middle) <= 2) && narrowed.page.scroll <= narrowed.page.width, `375px ${scheme}: still one row, no sideways scroll: ${JSON.stringify(narrowed)}`);
      // With the lane still picked, a search that opens an item makes All the selected filter too; the compact action
      // says New and retains its accessible name.
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && view.state === 'all' && view.lane === 'web' && document.querySelector('#find-results').hidden");
      const both = await read();
      assert.deepEqual([both.filterLabel, both.bar.map((part) => part.name)], ['Filter: All · web', ['list', 'pipeline', 'filter-toggle', 'new-item']], `375px ${scheme}: All and the picked lane both show: ${JSON.stringify([both.filterLabel, both.bar])}`);
      assert.ok(both.bar.every((part) => Math.abs(part.middle - both.bar[0].middle) <= 2) && both.page.scroll <= both.page.width && both.page.body <= both.page.width, `375px ${scheme}: both filters on one row, no sideways scroll: ${JSON.stringify(both)}`);
      assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify((() => { const go = document.querySelector('#new-item'); return [go.innerText, go.getAttribute('aria-label')]; })())")), ['New', 'New item'], `375px ${scheme}: New reads New below 900px and keeps its accessible name (#429)`);
      // A long lane name gives way rather than the row: with the coordinator lane picked, still one row.
      await lane('coordinator');
      await chrome.waitFor("view.lane === 'coordinator'");
      const long = await read();
      assert.deepEqual(long.bar.map((part) => part.name), ['list', 'pipeline', 'filter-toggle', 'new-item'], `375px ${scheme}: a long lane keeps every control: ${JSON.stringify(long.bar)}`);
      assert.ok(long.bar.every((part) => Math.abs(part.middle - long.bar[0].middle) <= 2) && long.page.scroll <= long.page.width && long.page.body <= long.page.width, `375px ${scheme}: a long lane name gives way, not the row: ${JSON.stringify(long)}`);
      await chooseFilter('state', 'active');
      await lane('');
      await chrome.waitFor('view.lane === null');
      assert.deepEqual((await read()).bar.map((part) => part.name), ['list', 'pipeline', 'filter-toggle', 'new-item'], `375px ${scheme}: every lane shown, all controls remain`);
      assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([document.querySelector('#new-item').innerText, document.querySelector('#new-item').getAttribute('aria-label')])")), ['New', 'New item'], `375px ${scheme}: New stays compact and named when filters clear`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the search step names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const alpha = project(box, 'stalled-search');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stalled-search-chrome-'));
  let chrome;
  /** The record a timed-out search step carries, read from its message. */
  const record = (error) => JSON.parse(error.message.slice(error.message.indexOf('{')));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    try {
      await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 1");
    } catch (error) {
      // Snapshot the request list before the asynchronous page observation; never replace the wait failure.
      let capture;
      try {
        capture = await searchSetupState(chrome);
      } catch (captureError) {
        capture = {
          caughtAt: new Date().toISOString(), pageObservedAt: null,
          project: null, itemCount: null, lastStateRequest: null,
          captureError: `${captureError.name}: ${captureError.message}`,
          rootCauseStatus: 'NOT PROVEN',
        };
      }
      error.diagnostic = capture;
      error.message += `; search setup state observed after timeout ${JSON.stringify(capture)}`;
      throw error;
    }
    // A field that takes no typing: the step times out, and its message says how far the search got.
    await chrome.stable("document.querySelector('#q').disabled = true");
    let stalled;
    await assert.rejects(searchFor(chrome, 'greeting', 1_500), (error) => { stalled = error; return true; });
    assert.match(stalled.message, /^the search for "greeting" did not show its results: \{/, 'the step says which search stalled');
    assert.deepEqual(Object.keys(record(stalled)), ['value', 'focused', 'windowFocus', 'resultsHidden', 'closedBy'], 'it records the value, the focus, the window focus, and the results with what closed them');
    assert.deepEqual([record(stalled).value, record(stalled).focused, typeof record(stalled).windowFocus, record(stalled).resultsHidden], ['', 'body', 'boolean', true], `no words reached the field, which never had focus: ${stalled.message}`);
    // Results that showed and were then closed say what closed them: here, leaving the field.
    await chrome.stable("document.querySelector('#q').disabled = false");
    await searchFor(chrome, 'greeting');
    await chrome.stable("document.querySelector('#q').blur()");
    await chrome.waitFor("document.querySelector('#find-results').hidden");
    assert.equal(await chrome.stable("document.querySelector('#find-results').dataset.why"), 'left the field', 'leaving the field closes the results and says so');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});


test('search keeps focus through Esc [N26,C7]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search-focus checks.');
  const box = machine(), demo = project(box, 'search-focus');
  box.run(demo.repo, 'add', 'web', 'Greeting focus proof', '--specs', 'G1', '--criterion', 'visible');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'search-focus-chrome'));
    await chrome.waitFor('data?.project?.items?.length === 1');
    await chrome.stable(`(() => {
      window.__searchFocus = [];
      document.querySelector('#q').addEventListener('keydown', event => {
        if (event.key === 'Escape') window.__searchFocus.push({ focused: document.activeElement.id, window: document.hasFocus(), key: event.key });
      }, { capture: true });
    })()`);
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await searchFor(chrome, 'Greeting');
      assert.equal(await chrome.stable('document.activeElement.id'), 'q', `${width}: typing and settling results retain the search field's focus`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      // budget: 120ms is the page's declared blur-close delay; observe after that callback can run.
      await chrome.stable('new Promise(resolve => setTimeout(resolve, 120))');
      const result = await chrome.stable(`({ focus: window.__searchFocus.at(-1), value: document.querySelector('#q').value, hidden: document.querySelector('#find-results').hidden, why: document.querySelector('#find-results').dataset.why })`);
      assert.equal(result.focus?.focused, 'q', `${width}: Escape is actually delivered while the search field is focused`);
      assert.equal(result.focus?.key, 'Escape');
      assert.deepEqual([result.value, result.hidden, result.why], ['', true, 'escape'], `${width}: Escape's own blur does not replace its close reason`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
