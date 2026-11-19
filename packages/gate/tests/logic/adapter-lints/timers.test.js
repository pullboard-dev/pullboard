/** @pullboard-test-input source-cell gate */
/** The timer lint counts deferrals, polls and pauses per file and kind, and holds today's counts at a ceiling [C7,#9518]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { CLOCK_CEILING_FILE } from '../../../src/io/adapter-lints/clock.js';
import {
  TIMERS_CEILING_FILE,
  timerLintRows,
  timerUses,
} from '../../../src/io/adapter-lints/timers.js';

/** A scratch repo holding `files`, with an optional timers ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-timerlint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(TIMERS_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.logic-adapter-lints-timers.with-the-setting-on-a-file: clause 1: with the setting on, a file gaining a deferral, poll or pause fails naming file, kind and line [C7,#9518]', () => {
  const root = repo({
    'packages/a/src/x.js': [
      'setTimeout(() => {}, 0);',
      'setImmediate(f);',
      'queueMicrotask(f);',
      'setInterval(f, 1000);',
      "import { setTimeout as wait } from 'node:timers/promises';",
      '',
    ].join('\n'),
  });
  const rows = timerLintRows(root, { enabled: true });
  assert.equal(rows.length, 5);
  assert.ok(rows.some(row => /^packages\/a\/src\/x\.js:1: deferral0 /u.test(row)));
  assert.ok(rows.some(row => /^packages\/a\/src\/x\.js:4: poll /u.test(row)));
  assert.ok(rows.some(row => /^packages\/a\/src\/x\.js:5: pause /u.test(row)));
});

test('gate.logic-adapter-lints-timers.a-slow-interval-a-budget-marked: clause 1: a slow interval, a budget-marked poll, comments and method calls are not counted [C7,#9518]', () => {
  const uses = timerUses([
    'setInterval(f, 5000);',
    'setTimeout(f, 250);',
    '// budget: the lease heartbeat is a real wait',
    'setInterval(f, 100);',
    '// setImmediate(f);',
    'socket.setTimeout(0);',
    '',
  ].join('\n'));
  assert.deepEqual(uses, []);
});

test('gate.logic-adapter-lints-timers.an-awaited-sleep-inside-a-loop: clause 1: an awaited sleep inside a loop is a poll, outside a loop it is not [C7,#9518]', () => {
  const looped = timerUses('async function w() {\n  while (!done()) {\n    await sleep(50);\n  }\n}\n');
  assert.deepEqual(looped.map(use => [use.line, use.kind]), [[3, 'poll']]);
  assert.deepEqual(timerUses('async function w() {\n  await sleep(50);\n}\n'), []);
});

test('gate.logic-adapter-lints-timers.counts-at-their-ceiling-pass-a: clause 2: counts at their ceiling pass, a rise in any kind fails, and a swap between kinds fails [C7,#9518]', () => {
  const ceilings = { 'packages/a/src/x.js': { deferral0: 1 } };
  const at = repo({ 'packages/a/src/x.js': 'setImmediate(f);\n' }, ceilings);
  assert.deepEqual(timerLintRows(at, { enabled: true }), []);
  const grown = repo({ 'packages/a/src/x.js': 'setImmediate(f);\nsetImmediate(g);\n' }, ceilings);
  assert.equal(timerLintRows(grown, { enabled: true }).length, 2);
  const swapped = repo({ 'packages/a/src/x.js': 'setInterval(f, 10);\n' }, ceilings);
  const rows = timerLintRows(swapped, { enabled: true });
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:1: poll /u);
  const fell = repo({ 'packages/a/src/x.js': 'export const a = 1;\n' }, ceilings);
  assert.deepEqual(timerLintRows(fell, { enabled: true }), []);
});

test('gate.logic-adapter-lints-timers.the-lint-holds-its-own-ceilings: clause 2: the lint holds its own ceilings file and leaves the clock ceilings file untouched [C7,#9518]', () => {
  assert.notEqual(TIMERS_CEILING_FILE, CLOCK_CEILING_FILE);
  const root = repo({ 'packages/a/src/x.js': 'setImmediate(f);\n' }, { 'packages/a/src/x.js': { deferral0: 1 } });
  const clockFile = join(root, CLOCK_CEILING_FILE);
  mkdirSync(dirname(clockFile), { recursive: true });
  writeFileSync(clockFile, '{"version":1,"files":{}}');
  timerLintRows(root, { enabled: true });
  assert.equal(readFileSync(clockFile, 'utf8'), '{"version":1,"files":{}}');
});

test('gate.logic-adapter-lints-timers.with-the-setting-off-which-is: clause 3: with the setting off, which is the default, the lint reports nothing [C7,#9518]', () => {
  const root = repo({ 'packages/a/src/x.js': 'setImmediate(f);\nsetInterval(f, 10);\n' });
  assert.deepEqual(timerLintRows(root), []);
  assert.deepEqual(timerLintRows(root, { enabled: false }), []);
  assert.deepEqual(timerLintRows(root, { enabled: 'yes' }), []);
});
