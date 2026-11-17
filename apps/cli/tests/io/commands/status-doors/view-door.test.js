/** @pullboard-test-input source-cell apps/cli */
/**
 * pullboard status reaches the view app only through its needs door, apps/view/needs.js, never the view barrel, so the view shell stays out of the cold status closure [C7].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
/** Every module specifier status.js names, static or dynamic, that points into the view app. */
const VIEW_SPECIFIERS = [...STATUS.matchAll(/(?:from\s*|import\s*\(\s*)'([^']*view\/[^']*)'/gu)].map(match => match[1]);

test('clause 1: status.js imports the view only through view/needs.js [C7]', () => {
  assert.ok(VIEW_SPECIFIERS.length > 0, 'status.js no longer names the view needs door');
  for (const specifier of VIEW_SPECIFIERS) assert.ok(specifier.endsWith('/view/needs.js'), `${specifier} is not the view needs door`);
});

test('clause 1: status.js never imports view/index.js [C7]', () => {
  assert.doesNotMatch(STATUS, /view\/index\.js/u);
});
