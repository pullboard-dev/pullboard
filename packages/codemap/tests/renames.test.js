/** @pullboard-test-input source-cell codemap */
/** @pullboard-world-pin reads the committed rename table to prove it is complete and clean under the layout rules. */
/**
 * The rename table for the layout freeze keeps its promises [V32,V33]: one row per old path, no two files mapped to one
 * new path, every merge target present, and every new path is a plain relative path under apps/, packages/, docs/, skills/ or a dot folder.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rows = readFileSync(new URL('../data/plan/renames.tsv', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t'));
const moved = rows.filter(([, to]) => to !== 'delete' && !to.startsWith('merge:')).map(([, to]) => to);

test('every old path has one row and every row names a new path, a delete or a merge [V32,V33]', () => {
  assert.equal(new Set(rows.map(([from]) => from)).size, rows.length);
  for (const row of rows) assert.ok(row.length === 2 || (row.length === 3 && row[1] === 'delete'), row.join(' '));
});

test('no two files map to one new path and every merge joins a file that exists [V32,V33]', () => {
  assert.equal(new Set(moved).size, moved.length);
  for (const [from, to] of rows.filter(([, to]) => to.startsWith('merge:'))) assert.ok(moved.includes(to.slice('merge:'.length)), from);
});

test('every new path is a plain relative path under the allowed roots [V32,V33]', () => {
  for (const path of moved) assert.match(path, /^(?:apps|packages|docs|skills|\.github|\.githooks)\/|^[^/]+$/u, path);
  assert.ok(!moved.some(path => /^(?:bin|src|relay|test)\//u.test(path)));
});
