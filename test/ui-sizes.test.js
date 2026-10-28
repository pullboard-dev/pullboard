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
import { uiSizeProblems } from '../bin/checks/ui-sizes.js';

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
function run(root) {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/checks/ui-sizes.js'), root], { encoding: 'utf8' });
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
  // The count itself is C12's: the doctrine row holds it, and it can only fall.
  assert.ok(uiSizeProblems(ROOT).every((problem) => /^(src|relay)\//u.test(problem.path)), 'only stylesheets under src/ and relay/ are read');
});
