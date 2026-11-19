/** @pullboard-test-input packages/runners/src/io/keyed.js packages/runners/src/io/source/scan.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: the clauses read the committed runner sources and the committed cells-edges ceiling. */
/** loadKeyedResult has one home, the pin cell's, and the runner callers reach it through the transport cell they already import [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadKeyedResult as pinned } from '../../../pin/light.js';
import { loadKeyedResult as runners } from '../../src/io/keyed.js';

const CEILING = 'packages/gate/data/ceilings/cells-edges.json';
const root = new URL('../../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

/** The ceiling file as the merge base with main committed it, or null when no main ref exists in this checkout. */
function ceilingAtMergeBase() {
  for (const ref of ['main', 'origin/main']) {
    try {
      const cwd = root.pathname;
      const base = execFileSync('git', ['merge-base', 'HEAD', ref], { cwd, encoding: 'utf8' }).trim();
      return execFileSync('git', ['show', `${base}:${CEILING}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    } catch { /* try the next ref */ }
  }
  return null;
}

test('runners.keyed-load.the-runner-keyed-module-exports-the: clause 1: the runner keyed module exports the pin cell\'s loadKeyedResult and defines no function of that name [C7]', () => {
  assert.equal(runners, pinned, 'the runner export is the pin function itself');
  assert.doesNotMatch(read('packages/runners/src/io/keyed.js'), /function\s+loadKeyedResult\b|loadKeyedResult\s*=/u);
});

test('runners.keyed-load.keyed-js-and-scan-js-import: clause 2: keyed.js and scan.js import no file under packages/pin [C7]', () => {
  for (const file of ['packages/runners/src/io/keyed.js', 'packages/runners/src/io/source/scan.js']) {
    assert.doesNotMatch(read(file), /from\s+'[^']*\bpin\//u, `${file} reaches pin only through the transport cell`);
  }
});

test('runners.keyed-load.cells-edges-json-adds-no-row: clause 3: no cells-edges.json row or entry at HEAD is missing from the merge base, so no ceiling rose and rows may only be removed [C7]', () => {
  const base = ceilingAtMergeBase();
  if (base !== null) {
    const rows = (before, after, path) => {
      if (before === null || typeof before !== 'object') return;
      for (const [key, value] of Object.entries(after ?? {})) {
        assert.ok(Array.isArray(before) ? before.includes(value) : key in before, `${path}${key} is new since the merge base`);
        if (!Array.isArray(value)) rows(before[key], value, `${path}${key}.`);
      }
    };
    rows(JSON.parse(base), JSON.parse(read(CEILING)), '');
  }
  assert.ok(!JSON.parse(read(CEILING)).cells.runners.imports.includes('pin'), 'runners must not list pin');
});
