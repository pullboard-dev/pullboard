/** @pullboard-test-input test-tree */
/** @pullboard-test-gui */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { selectAffectedTests } from '../../src/affected-tests.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';
import { press, waitForStableBoxes } from './stable.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COCKPIT = join(ROOT, 'test', 'cockpit');
const EXEMPT_FUNCTIONS = new Set(['rawChromeEvaluation', 'waitForStableBoxes', 'press', 'tapTouch']);

/** Find complete top-level exception bodies without exempting the rest of stable.js. */
function maskSharedChromeFunctions(source) {
  const lines = source.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/.exec(lines[start]);
    if (!declaration || !EXEMPT_FUNCTIONS.has(declaration[1])) continue;
    let end = start + 1;
    while (end < lines.length && lines[end] !== '}') end += 1;
    if (end === lines.length) continue;
    for (let line = start; line <= end; line += 1) lines[line] = '';
    start = end;
  }
  return lines.join('\n');
}

/** Return every forbidden raw Chrome call with a cockpit-relative path and source line. */
function rawChromeBypasses(root = COCKPIT) {
  const patterns = [
    ['direct evaluate', new RegExp('(?<!Runtime)\\.\\s*' + 'evaluate' + '\\b')],
    ['computed evaluate', new RegExp('\\[\\s*[\'"]' + 'evaluate' + '[\'"]\\s*\\]')],
    ['unwaited DOM click', new RegExp('\\.\\s*' + 'click' + '\\s*\\(\\s*\\)')],
    ['raw protocol', new RegExp('[\'"](?:Runtime\\.(?:evaluate|callFunctionOn)|DOM\\.(?:getBoxModel|getContentQuads)|Page\\.getLayoutMetrics|Input\\.dispatch(?:Mouse|Touch)Event)[\'"]')],
    ['unwrapped Chrome client', new RegExp('\\bstart' + 'Chrome\\s*\\(')],
  ];
  const files = [];
  /** Include future nested Chrome test files in the boundary check. */
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) files.push(path);
    }
  }
  walk(root);
  const violations = [];
  for (const path of files) {
    let source = readFileSync(path, 'utf8');
    if (basename(path) === 'stable.js' && relative(root, path) === 'stable.js') {
      source = maskSharedChromeFunctions(source);
    }
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const guardedLine = lines[index].replace(new RegExp('\\bstable' + 'Chrome\\s*\\(\\s*await\\s+start' + 'Chrome\\s*\\(', 'gu'), '(');
      for (const [kind, pattern] of patterns) {
        if (pattern.test(guardedLine)) violations.push({ file: relative(root, path), line: index + 1, kind });
      }
    }
  }
  return violations;
}

test('real Chrome tests measure and click only through the shared wait [N26,C7]', () => {
  assert.deepEqual(rawChromeBypasses(), [], 'every cockpit test uses the stable API; raw CDP plumbing stays in the four named helpers');
});

test('the shared-wait guard reports a synthetic direct Chrome evaluation by file and line [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-guard-'));
  try {
    mkdirSync(join(root, 'nested'));
    const directCall = ['chrome', '.', 'evaluate', '(', JSON.stringify(["document.querySelector('.card')", ".", "click", "()"].join("")), ')'].join('');
    const alias = ['chrome', '[', JSON.stringify('evaluate'), ']'].join('');
    writeFileSync(join(root, 'nested', 'direct.test.js'), `const ready = true;\n${directCall};\nconst saved = ${alias};\n`);
    assert.deepEqual(rawChromeBypasses(root), [{ file: 'nested/direct.test.js', line: 2, kind: 'direct evaluate' }, { file: 'nested/direct.test.js', line: 2, kind: 'unwaited DOM click' }, { file: 'nested/direct.test.js', line: 3, kind: 'computed evaluate' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw protocol exceptions are limited to named stable helpers [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-scope-'));
  try {
    writeFileSync(join(root, 'stable.js'), [
      'export async function rawChromeEvaluation(chrome) {',
      '  return chrome.send(' + JSON.stringify(['Runtime', 'evaluate'].join('.')) + ', {});',
      '}',
      'export async function waitForStableBoxes(chrome) {',
      '  return chrome.send(' + JSON.stringify(['DOM', 'getBoxModel'].join('.')) + ', {});',
      '}',
      'export async function press(chrome) {',
      '  return chrome.send(' + JSON.stringify(['Input', 'dispatchMouseEvent'].join('.')) + ', {});',
      '}',
      'export async function tapTouch(chrome) {',
      '  return chrome.send(' + JSON.stringify(['Input', 'dispatchTouchEvent'].join('.')) + ', {});',
      '}',
      'export async function accidentalBypass(chrome) {',
      `  return ${['chrome', '.', 'evaluate', '(', "'outside helper'", ')'].join('')};`,
      '}',
    ].join('\n') + '\n');
    assert.deepEqual(rawChromeBypasses(root), [{ file: 'stable.js', line: 14, kind: 'direct evaluate' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the guard catches each low-level protocol bypass outside shared helpers [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-protocol-'));
  try {
    const forbiddenCalls = [
      ['Runtime', 'evaluate'], ['Runtime', 'callFunctionOn'], ['DOM', 'getBoxModel'],
      ['DOM', 'getContentQuads'], ['Page', 'getLayoutMetrics'], ['Input', 'dispatchMouseEvent'], ['Input', 'dispatchTouchEvent'],
    ].map(parts => `chrome.send(${JSON.stringify(parts.join('.'))}, {});`);
    const constructor = ['start', 'Chrome', '()'].join('');
    const wrapped = ['stable', 'Chrome', '(await ', constructor, ')'].join('');
    writeFileSync(join(root, 'protocol.test.js'), forbiddenCalls.concat(`const raw = await ${constructor};`, `const safe = await ${wrapped};`).join('\n') + '\n');
    assert.deepEqual(rawChromeBypasses(root), forbiddenCalls.map((_, index) => ({ file: 'protocol.test.js', line: index + 1, kind: 'raw protocol' })).concat({ file: 'protocol.test.js', line: forbiddenCalls.length + 1, kind: 'unwrapped Chrome client' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('real Chrome retains reduced motion and jumps both detail panes without animation [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for motion checks.');
  const box = machine(), demo = project(box, 'motion-demo');
  box.run(demo.repo, 'add', 'web', 'Jump to this detail', '--specs', 'G1', '--criterion', 'visible');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'motion-chrome'));
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      assert.equal(await chrome.stable("matchMedia('(prefers-reduced-motion: reduce)').matches"), true, `${scheme}: a later media override keeps reduced motion`);
      assert.equal(await chrome.stable(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), true);
    }
    await chrome.stable(`(() => {
      const probe = document.createElement('div'); probe.id = 'motion-proof';
      probe.style.cssText = 'position:fixed;width:10px;height:10px;transition:width 2s;animation:proof-motion 2s infinite;scroll-behavior:smooth';
      document.body.append(probe);
      window.__detailScrolls = [];
      const original = Element.prototype.scrollIntoView;
      /** Record the actual navigation scroll while retaining Chrome behavior. */
      Element.prototype.scrollIntoView = function(options) { window.__detailScrolls.push({id:this.id,behavior:options?.behavior}); return original.call(this, options); };
    })()`);
    assert.deepEqual(await chrome.stable(`(() => {const style=getComputedStyle(document.querySelector('#motion-proof'));return [style.transitionDuration,style.animationName,style.scrollBehavior];})()`), ['0s', 'none', 'auto'], 'reduced motion disables transitions, animations and CSS smooth scrolling');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await press(chrome, "document.querySelector('#chain .row')");
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Jump to this detail')");
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await press(chrome, `document.querySelector('#spec-chips [data-rows="spec:all"]')`);
    await press(chrome, `document.querySelector('#spec-list [data-row="spec:G2"]')`);
    const scrolls = await chrome.stable('window.__detailScrolls');
    for (const id of ['detail', 'spec-detail']) assert.ok(scrolls.some(entry => entry.id === id && entry.behavior === 'instant'), `${id} jumps immediately: ${JSON.stringify(scrolls)}`);
    await chrome.stable(`(() => {
      const probe=document.createElement('div'); probe.id='zero-box-proof'; probe.style.cssText='position:fixed;width:0;height:0'; document.body.append(probe);
      let frame=0; const grow=()=>{frame++;probe.dataset.frames=String(frame);if(frame===20){probe.style.width='10px';probe.style.height='10px';}else requestAnimationFrame(grow);};requestAnimationFrame(grow);
    })()`);
    await waitForStableBoxes(chrome, "document.querySelector('#zero-box-proof')");
    assert.equal(Number(await chrome.stable("document.querySelector('#zero-box-proof').dataset.frames")), 20, 'the shared wait does not accept an existing zero-size target');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});


test('the shared wait survives a redrawn element [N26,C7]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for redraw checks.');
  const box = machine();
  project(box, 'redrawn-target');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'redrawn-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.stable(`(() => {
      const button = document.createElement('button'); button.id = 'redrawn-proof'; button.textContent = 'Redrawn target';
      button.style.cssText = 'position:fixed;top:180px;left:20px;width:160px;height:44px'; document.body.append(button);
      window.__redrawSamples = 0; window.__redrawGap = false;
    })()`);
    // Resolve the real target each frame. The first sample detaches it; the second sees the same
    // null.closest gap as macOS CI, before the replacement is inserted on the following frame.
    const find = `(() => {
      const node = document.querySelector('#redrawn-proof'); window.__redrawSamples++;
      if (window.__redrawSamples === 1) {
        node.remove();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const replacement = node.cloneNode(true); replacement.dataset.replaced = 'yes'; document.body.append(replacement);
        }));
      }
      if (!node) window.__redrawGap = true;
      return node.closest('button');
    })()`;
    await assert.doesNotReject(() => waitForStableBoxes(chrome, find), 'a disappearing selector is sampled again until its replacement settles');
    assert.deepEqual(await chrome.stable(`[window.__redrawGap, document.querySelector('#redrawn-proof').dataset.replaced, window.__redrawSamples >= 4]`), [true, 'yes', true]);
    const missing = `document.querySelector('#never-redrawn-proof').closest('button')`;
    // budget: this deliberately missing target's short deadline bounds the diagnostic control.
    await assert.rejects(() => waitForStableBoxes(chrome, missing, 100), error => { // budget: declared 100 ms negative diagnostic deadline for this deliberately absent selector.
      assert.match(error.message, /never-redrawn-proof/, 'the timeout names the selector');
      assert.match(error.message, /last saw.*(?:TypeError|closest|null)/i, 'the timeout retains the last failed sample');
      return true;
    });
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});

test('a timeout always reports the last sample [N26,C7]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled timeout diagnostic');
  const box = machine();
  project(box, 'timeout-last-sample');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'timeout-last-sample-chrome'));
    await chrome.waitFor('!!data?.project');
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const missing = "document.querySelector('#never-sampled-proof').closest('button')";
    await assert.rejects(() => waitForStableBoxes(chrome, missing, 1), error => { // budget: declared 1 ms first-sample negative diagnostic deadline for this absent selector.
      assert.match(error.message, /never-sampled-proof/, 'the timeout names the missing target');
      assert.match(error.message, /last saw.*TypeError/i, 'the 1 ms timeout includes the first sampled failure');
      return true;
    });
    assert.deepEqual(chrome.exceptions, [], 'the missing target is reported without an uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});


test('a changed cockpit test selects the shared-wait scanner [C7,B3]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-view-scanner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', ROOT, root]);
  /** Commit real private repository inputs without changing the user's Git identity. */
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'test/cockpit/shared-wait.test.js'), readFileSync(join(COCKPIT, 'shared-wait.test.js')));
  git('add', '--', 'test/cockpit/shared-wait.test.js');
  // A committed scanner already matches its clone; an empty baseline still pins that input.
  git('commit', '--allow-empty', '--quiet', '-m', 'test(view): preserve actual scanner input [C7,B3]');
  const base = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'test/cockpit/demo.test.js'), '\n// Only the cockpit scanner input changes.\n');
  git('add', '--', 'test/cockpit/demo.test.js');
  git('commit', '--quiet', '-m', 'test(view): change only cockpit input [C7,B3]');
  const commit = git('rev-parse', 'HEAD');
  assert.deepEqual(git('diff', '--name-only', base, commit).split('\n'), ['test/cockpit/demo.test.js'], 'the actual repository changes only the cockpit test');
  const selection = selectAffectedTests(root, { base, commit });
  assert.equal(selection.full, false, 'a cockpit-only change retains affected selection');
  assert.ok(selection.files.includes('test/cockpit/shared-wait.test.js'), 'the actual shared-wait scanner is selected');
});
