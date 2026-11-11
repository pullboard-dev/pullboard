/** @pullboard-test-input source-tree */
/**
 * The ui-sizes Rigor check (C12): a size typed by hand in a stylesheet under src/ or relay/ is one
 * problem, at its line; the scale's own custom properties, comments, 1px hairlines and every other
 * property are not. On the live tree the check holds the stylesheets to the scale apps/view/src/io/main.css defines.
 */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  uiSizeCounts,
  uiSizeProblems,
} from '../../src/io/sizes.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
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
  const result = spawnSync(process.execPath, [join(ROOT, 'packages/gate/src/io/sizes.js'), root, ...args], { encoding: 'utf8' });
  return { status: result.status, lines: result.stdout.split('\n').filter(Boolean) };
}

test('a stylesheet drawn from the scale has no problems and exits 0 [C12,N26]', () => {
  const root = tree('clean', {
    'apps/view/src/io/main.css': ':root { --space-3: 8px; --text-sm: 13px; --radius-md: 6px; }\n/* padding: 10px in a comment */\n'
      + '.a { padding: var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-md); border: 1px solid; margin: 0 1px; width: 22px; }\n',
  });
  assert.deepEqual(run(root), { status: 0, lines: [] });
});

test('each size typed by hand is one problem at its line, and the check exits 1 [C12,N26]', () => {
  const root = tree('typed', {
    'apps/view/src/io/main.css': '.a { padding: 10px var(--space-3); }\n.b {\n  font: 600 11px/1 var(--mono);\n  border-top-left-radius: 7px;\n  margin: -6px 0;\n}\n',
    'apps/relay/src/io/deploy/screens.css': '.c { gap: 12px; font-size: 16px; }\n',
    'docs/demo/view.css': '.d { padding: 99px; }\n',
  });
  assert.deepEqual(run(root), { status: 1, lines: [
    'apps/relay/src/io/deploy/screens.css:1: font-size 16px is typed by hand: use a --text-* token from apps/view/src/io/main.css',
    'apps/relay/src/io/deploy/screens.css:1: gap 12px is typed by hand: use a --space-* token from apps/view/src/io/main.css',
    'apps/view/src/io/main.css:1: padding 10px is typed by hand: use a --space-* token from apps/view/src/io/main.css',
    'apps/view/src/io/main.css:3: font 11px is typed by hand: use a --text-* token from apps/view/src/io/main.css',
    'apps/view/src/io/main.css:4: border-top-left-radius 7px is typed by hand: use a --radius-* token from apps/view/src/io/main.css',
    'apps/view/src/io/main.css:5: margin 6px is typed by hand: use a --space-* token from apps/view/src/io/main.css',
  ] });
});

test('the live stylesheet defines the scale the check points to [C12,N26]', () => {
  const view = readFileSync(join(ROOT, 'apps/view/src/io/main.css'), 'utf8');
  for (const token of ['--text-sm', '--space-3', '--radius-card', '--round']) assert.match(view, new RegExp(`${token}:`), `apps/view/src/io/main.css defines ${token}`);
  // Only the deliberately raw glyphs, large layout paddings and Dashboard number remain (#1594/#1668).
  assert.equal(uiSizeCounts(ROOT)['apps/relay/src/io/browser/screens.css'], 0, 'the actual relay stylesheet uses the shared scale');
  assert.ok(uiSizeProblems(ROOT).every((problem) => /^apps\/(view|relay)\/src\//u.test(problem.path)), 'only stylesheets under apps/view/src/ and apps/relay/src/ are read');
});

test('the counts report retains clean relay files and excludes generated documentation [N26]', () => {
  const root = tree('counts', {
    'apps/view/src/io/main.css': ':root { --text-sm: 13px; }\n.a { font-size: 11px; padding: 4px; }\n',
    'apps/relay/src/io/deploy/browser-screens.css': '.relay { font-size: var(--text-sm); margin: 0 1px; }\n',
    'docs/demo/view.css': '.generated { padding: 99px; }\n',
  });
  const expected = { 'apps/relay/src/io/deploy/browser-screens.css': 0, 'apps/view/src/io/main.css': 2 };
  assert.deepEqual(uiSizeCounts(root), expected, 'counts come from the real scanner, including explicit zero');
  const reported = run(root, '--counts');
  assert.equal(reported.status, 0, 'count reporting is available even when raw sizes remain');
  assert.deepEqual(JSON.parse(reported.lines.join('\n')), expected, 'the actual executable reports counts per file');
});


test('clause 1: the view has only the approved raw sizes, including CSS added after the scale landed [C12,N26]', () => {
  const lines = readFileSync(join(ROOT, 'apps/view/src/io/main.css'), 'utf8').split('\n');
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
    // The first-run Dashboard block, approved size by size (selector and size), not as a block: a new raw size there fails.
    ['.first-run {', 'gap 14px'],
    ['.first-run-rules li:not(.arr) {', 'gap 12px'],
    ['.first-run-rules li:not(.arr) {', 'padding 14px'],
    ['.first-run-rules li:not(.arr) {', 'padding 16px'],
    ['.first-run-rules li:not(.arr) {', 'border-radius 10.5px'],
    ['.first-run-rules li:not(.arr) {', 'font-size 15px'],
    ['.first-run-rules .arr {', 'font-size 18px'],
    ['.first-run-rules b {', 'font-size 14px'],
    ['.first-run-card {', 'border-radius 10.5px'],
    ['.first-run-two {', 'padding 24px'],
    ['.first-run-two {', 'padding 28px'],
    ['.first-run-how {', 'padding 28px'],
    ['.first-run-start {', 'padding-left 28px'],
    ['.first-run-dia .node text {', 'font 12.5px'],
    ['.first-run-dia .node .sub {', 'font 10.5px'],
    ['.first-run-dia .lbl {', 'font 10.5px'],
    ['.first-run-caption {', 'margin 8px'],
    ['.first-run-caption {', 'font-size 15px'],
    ['.first-run-tour {', 'gap 10px'],
    ['.first-run-tour {', 'margin-top 6px'],
    ['.first-run-tour button {', 'font-size 16px'],
    ['.first-run-dots {', 'gap 6px'],
    ['.first-run-start h2 {', 'margin 12px'],
    ['.first-run-start h2 {', 'font-size 24px'],
    ['.first-run-line {', 'gap 10px'],
    ['.first-run-line {', 'padding 8px'],
    ['.first-run-line {', 'padding 14px'],
    ['.first-run-line {', 'border-radius 10px'],
    ['.first-run-line code {', 'font 15px'],
    ['.first-run-line button {', 'border-radius 6px'],
    ['.first-run-line button {', 'padding 6px'],
    ['.first-run-line button {', 'padding 16px'],
    ['.first-run-line button {', 'font-size 13.5px'],
    ['.first-run-checks {', 'margin 16px'],
    ['.first-run-checks {', 'margin 12px'],
    ['.first-run-checks {', 'gap 6px'],
    ['.first-run-checks li {', 'gap 10px'],
    ['.first-run-checks li {', 'font-size 14px'],
    ['.first-run-checks li i {', 'font-size 11px'],
    ['.first-run-checks li small.hint {', 'font-size 13px'],
    ['.first-run-checks li.after {', 'margin-top 6px'],
    ['.first-run-checks li.after {', 'padding-left 30px'],
    ['.first-run-checks li.after {', 'font-size 16px'],
    ['.first-run-arch {', 'padding 16px'],
    ['.first-run-arch {', 'padding 18px'],
    ['.first-run-dhead {', 'gap 12px'],
    ['.first-run-dhead {', 'margin-bottom 12px'],
    ['.first-run-dhead h2 {', 'font-size 18px'],
    ['.first-run-dhead span {', 'font-size 13px'],
    ['.first-run-tiles {', 'gap 10px'],
    ['.first-run-tile {', 'gap 10px'],
    ['.first-run-tile {', 'padding 12px'],
    ['.first-run-tile {', 'padding 14px'],
    ['.first-run-tile {', 'border-radius 10.5px'],
    ['.first-run-tile .ico {', 'border-radius 8px'],
    ['.first-run-tile .k {', 'font-size 12px'],
    ['.first-run-tile b {', 'font-size 15px'],
    ['.first-run-tile a {', 'margin-top 2px'],
    ['.first-run-tile a {', 'font-size 12px'],
    ['.first-run-later {', 'font-size 13px'],
    ['.first-run-later {', 'padding 6px'],
    ['@media (max-width: 1000px) { .first-run-two {', 'padding 20px'],
    ['@media (max-width: 700px) { .first-run-checks li {', 'margin-left 30px'],
  ];
  // Only the sizes this change adds are held to the approved list: a size main already carries, at the same line text, never fails.
  const path = 'apps/view/src/io/main.css';
  const base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const baseText = execFileSync('git', ['show', `${base}:${path}`], { cwd: ROOT, encoding: 'utf8' });
  const baseRoot = tree(`base-${base}`, { [path]: baseText });
  const baseLines = baseText.split('\n');
  const onMain = new Map();
  for (const problem of uiSizeProblems(baseRoot).filter(found => found.path === path)) {
    const key = `${baseLines[problem.line - 1].trim()}|${problem.text}`;
    onMain.set(key, (onMain.get(key) ?? 0) + 1);
  }
  const added = [];
  for (const problem of uiSizeProblems(ROOT).filter(found => found.path === path)) {
    const key = `${lines[problem.line - 1].trim()}|${problem.text}`;
    if (onMain.get(key)) onMain.set(key, onMain.get(key) - 1);
    else added.push(problem);
  }
  for (const problem of added) {
    assert.ok(allowed.some(([selector, size]) => lines[problem.line - 1].trim().startsWith(selector)
      && problem.text.startsWith(`${size} is typed by hand:`)), `${problem.line}: ${problem.text}`);
  }
});
