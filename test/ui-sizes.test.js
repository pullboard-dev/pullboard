/** @pullboard-test-input source-tree */
/**
 * The ui-sizes Rigor check (C12): a size typed by hand in a stylesheet under src/ or relay/ is one
 * problem, at its line; the scale's own custom properties, comments, 1px hairlines and every other
 * property are not. On the live tree the check holds the stylesheets to the scale src/view.css defines.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { uiSizeCounts, uiSizeProblems } from '../bin/checks/ui-sizes.js';

const ROOT = resolve(import.meta.dirname, '..');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-ui-sizes-')));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fixture tree holding these files. */
function tree(name, files) {
  const root = join(dir, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Run the check as a doctrine row runs it. */
function run(root, ...args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/checks/ui-sizes.js'), root, ...args], { encoding: 'utf8' });
  return { status: result.status, lines: result.stdout.split('\n').filter(Boolean) };
}

test('a stylesheet drawn from the scale has no problems and exits 0 [C12,N26]', () => {
  const root = tree('clean', {
    'src/view.css': ':root { --space-3: 8px; --text-sm: 13px; --radius-md: 6px; }\n/* padding: 10px in a comment */\n'
      + '.a { padding: var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-md); border: 1px solid; margin: 0 1px; width: 22px; }\n',
  });
  assert.deepEqual(run(root), { status: 0, lines: [] });
});

test('each size typed by hand is one problem at its line, and the check exits 1 [C12,N26]', () => {
  const root = tree('typed', {
    'src/view.css': '.a { padding: 10px var(--space-3); }\n.b {\n  font: 600 11px/1 var(--mono);\n  border-top-left-radius: 7px;\n  margin: -6px 0;\n}\n',
    'relay/screens.css': '.c { gap: 12px; font-size: 16px; }\n',
    'docs/demo/view.css': '.d { padding: 99px; }\n',
  });
  assert.deepEqual(run(root), { status: 1, lines: [
    'relay/screens.css:1: font-size 16px is typed by hand: use a --text-* token from src/view.css',
    'relay/screens.css:1: gap 12px is typed by hand: use a --space-* token from src/view.css',
    'src/view.css:1: padding 10px is typed by hand: use a --space-* token from src/view.css',
    'src/view.css:3: font 11px is typed by hand: use a --text-* token from src/view.css',
    'src/view.css:4: border-top-left-radius 7px is typed by hand: use a --radius-* token from src/view.css',
    'src/view.css:5: margin 6px is typed by hand: use a --space-* token from src/view.css',
  ] });
});

test('the live stylesheet defines the scale the check points to [C12,N26]', () => {
  const view = readFileSync(join(ROOT, 'src/view.css'), 'utf8');
  for (const token of ['--text-sm', '--space-3', '--radius-card', '--round']) assert.match(view, new RegExp(`${token}:`), `src/view.css defines ${token}`);
  // Only the deliberately raw glyphs, large layout paddings and Dashboard number remain (#1594/#1668).
  assert.equal(uiSizeCounts(ROOT)['relay/browser-screens.css'], 0, 'the actual relay stylesheet uses the shared scale');
  assert.ok(uiSizeProblems(ROOT).every((problem) => /^(src|relay)\//u.test(problem.path)), 'only stylesheets under src/ and relay/ are read');
});

test('the counts report retains clean relay files and excludes generated documentation [N26]', () => {
  const root = tree('counts', {
    'src/view.css': ':root { --text-sm: 13px; }\n.a { font-size: 11px; padding: 4px; }\n',
    'relay/browser-screens.css': '.relay { font-size: var(--text-sm); margin: 0 1px; }\n',
    'docs/demo/view.css': '.generated { padding: 99px; }\n',
  });
  const expected = { 'relay/browser-screens.css': 0, 'src/view.css': 2 };
  assert.deepEqual(uiSizeCounts(root), expected, 'counts come from the real scanner, including explicit zero');
  const reported = run(root, '--counts');
  assert.equal(reported.status, 0, 'count reporting is available even when raw sizes remain');
  assert.deepEqual(JSON.parse(reported.lines.join('\n')), expected, 'the actual executable reports counts per file');
});


test('the view has only the approved raw sizes, including CSS added after the scale landed [C12,N26]', () => {
  const lines = readFileSync(join(ROOT, 'src/view.css'), 'utf8').split('\n');
  const allowed = [
    ['header.top {', 'padding-right 62px'],
    ['@media (pointer: coarse)', 'padding-bottom 72px'],
    ['.ob-panel {', 'padding 64px'],
    ['.shout .avatar.wide {', 'font-size 9px'],
    ['.agent-row .avatar {', 'font-size 10px'],
    ['.agent-row .avatar.wide {', 'font-size 8px'],
    ['.agent-pill .avatar {', 'font-size 8px'],
    ['.agent-pill .avatar.wide {', 'font-size 6.5px'],
    ['.heard-face {', 'font 7px'],
    ['.dash-rate > b {', 'font-size 34px'],
  ];
  const problems = uiSizeProblems(ROOT).filter(problem => problem.path === 'src/view.css');
  assert.ok(problems.length <= allowed.length, `only ${allowed.length} approved raw sizes remain, found ${problems.length}`);
  for (const problem of problems) {
    assert.ok(allowed.some(([selector, size]) => lines[problem.line - 1].trim().startsWith(selector)
      && problem.text.startsWith(`${size} is typed by hand:`)), `${problem.line}: ${problem.text}`);
  }
});
