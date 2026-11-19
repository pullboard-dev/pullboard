/** @pullboard-test-input test-tree */
/** @pullboard-world-pin: the affected-selection case copies this test's own source into a clone to prove the scanner is selected. */
/** A source-only guard for shared Chrome waits and affected test selection [N26,C7]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { selectAffectedTests } from '../../index.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
/** Test files whose subject is the raw Chrome client itself, each with the written reason its raw calls are allowed [C7]. */
const RAW_CLIENT_TESTS = new Map([
  ['packages/gate/tests/io/clone/devtools.test.js', "tests the raw CDP client's own evaluate formats, labels and command errors"],
  ['packages/gate/tests/io/clone/startup.test.js', "tests the raw Chrome client's own startup budget and diagnostics"],
  ['packages/gate/tests/io/clone/wait.test.js', "tests the raw CDP client's own waits through navigation errors"],
]);
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
function rawChromeBypasses(root = ROOT) {
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
  if (root === ROOT) {
    // The cockpit tests live beside their commands now: every Chrome-driving test under a tests or journeys folder.
    for (const group of ['apps', 'packages']) {
      for (const cell of readdirSync(join(ROOT, group))) {
        for (const folder of ['tests', 'journeys']) {
          const base = join(ROOT, group, cell, folder);
          if (existsSync(base)) walk(base);
        }
      }
    }
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const path = files[index];
      const cockpitHelper = /[\\/]tests[\\/]fixtures[\\/]cockpit[\\/]/u.test(path);
      const chromeTest = /\.test\.m?js$/u.test(path) && /chrome/iu.test(readFileSync(path, 'utf8'));
      if (!cockpitHelper && !chromeTest) files.splice(index, 1);
    }
  } else walk(root);
  const violations = [];
  for (const path of files) {
    if (RAW_CLIENT_TESTS.has(relative(root, path).split('\\').join('/'))) continue;
    let source = readFileSync(path, 'utf8');
    if (basename(path) === 'stable.js' && (relative(root, path) === 'stable.js' || path.endsWith(join('tests', 'fixtures', 'cockpit', 'stable.js')))) {
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

test('gate.logic-wait.real-chrome-tests-measure-and-click: real Chrome tests measure and click only through the shared wait [N26,C7]', () => {
  assert.deepEqual(rawChromeBypasses(), [], 'every cockpit test uses the stable API; raw CDP plumbing stays in the four named helpers');
});

test('gate.logic-wait.each-raw-client-allowance-names-a: each raw-client allowance names a real file, a written reason, and still holds raw calls [N26,C7]', () => {
  for (const [file, reason] of RAW_CLIENT_TESTS) {
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
    assert.ok(reason.length >= 20, `${file} states why its raw calls are allowed`);
    const raw = /(?<!Runtime)\.\s*evaluate\b|\bstartChrome\s*\(/u.test(readFileSync(join(ROOT, file), 'utf8'));
    assert.ok(raw, `${file} no longer holds raw calls; remove its allowance`);
  }
});

test('gate.logic-wait.the-shared-wait-guard-reports-a: the shared-wait guard reports a synthetic direct Chrome evaluation by file and line [N26,C7]', () => {
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

test('gate.logic-wait.raw-protocol-exceptions-are-limited-to: raw protocol exceptions are limited to named stable helpers [N26,C7]', () => {
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

test('gate.logic-wait.the-guard-catches-each-low-level: the guard catches each low-level protocol bypass outside shared helpers [N26,C7]', () => {
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

test('gate.logic-wait.a-changed-cockpit-test-selects-the: a changed cockpit test selects the shared-wait scanner [C7,B3]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-view-scanner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', ROOT, root]);
  /** Commit real private repository inputs without changing the user's Git identity. */
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'packages/gate/tests/logic/wait.test.js'), readFileSync(join(ROOT, 'packages/gate/tests/logic/wait.test.js')));
  git('add', '--', 'packages/gate/tests/logic/wait.test.js');
  // A committed scanner already matches its clone; an empty baseline still pins that input.
  git('commit', '--allow-empty', '--quiet', '-m', 'test(view): preserve actual scanner input [C7,B3]');
  const base = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'apps/cli/journeys/hold/demo.test.js'), '\n// Only the cockpit scanner input changes.\n');
  git('add', '--', 'apps/cli/journeys/hold/demo.test.js');
  git('commit', '--quiet', '-m', 'test(view): change only cockpit input [C7,B3]');
  const commit = git('rev-parse', 'HEAD');
  assert.deepEqual(git('diff', '--name-only', base, commit).split('\n'), ['apps/cli/journeys/hold/demo.test.js'], 'the actual repository changes only the cockpit test');
  const selection = selectAffectedTests(root, { base, commit });
  assert.equal(selection.full, false, `a cockpit-only change retains affected selection: ${selection.reason}; selected ${selection.files.length} files`);
  assert.ok(selection.files.includes('packages/gate/tests/logic/wait.test.js'), 'the actual shared-wait scanner is selected');
});
