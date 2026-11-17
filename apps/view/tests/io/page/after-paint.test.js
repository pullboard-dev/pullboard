/** @pullboard-test-input apps/view/src/io/page */
/** @pullboard-world-pin reads the page script's source and runs its afterPaint with stand-in frame and timer; a real paint needs a browser. */
/** The view has one afterPaint helper and the frame-then-timer idiom lives only there [C7,#9528]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

const PAGE = new URL('../../../src/io/page/', import.meta.url);
const SOURCES = readdirSync(PAGE).filter((name) => name.endsWith('.js')).map((name) => ({ name, text: readFileSync(new URL(name, PAGE), 'utf8') }));
const HOME = SOURCES.find((file) => file.name === 'render.js').text;

/** The page's own afterPaint, run against a stand-in frame queue and timer queue so the test runs what the page runs. */
function helper(frames, timers, withFrames = true) {
  const source = /function afterPaint\(fn\) \{[\s\S]*?\n\}/u.exec(HOME)[0];
  const frame = withFrames ? (next) => frames.push(next) : undefined;
  return new Function('requestAnimationFrame', 'setTimeout', `${source}; return afterPaint;`)(frame, (next) => timers.push(next));
}

test('clause 1: afterPaint(fn) runs fn once, after the next paint and a fresh turn [C7,#9528]', () => {
  const frames = [], timers = [], ran = [];
  helper(frames, timers)(() => ran.push('ran'));
  assert.deepEqual([ran.length, frames.length, timers.length], [0, 1, 0], 'nothing runs before the frame');
  frames.shift()();
  assert.deepEqual([ran.length, timers.length], [0, 1], 'the frame only schedules the turn');
  timers.shift()();
  assert.deepEqual([ran.length, frames.length, timers.length], [1, 0, 0], 'fn ran once and nothing is left queued');
});

test('clause 1: a page with no frames still runs fn on the next turn [C7,#9528]', () => {
  const frames = [], timers = [], ran = [];
  helper(frames, timers, false)(() => ran.push('ran'));
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(ran.length, 1);
});

test('clause 1: the six sites in actions.js, render.js and menu.js call afterPaint [C7,#9528]', () => {
  const calls = Object.fromEntries(SOURCES.map((file) => [file.name, [...file.text.matchAll(/\bafterPaint\(\(\) =>/gu)].length]));
  assert.equal(calls['actions.js'], 3, 'actions.js: the new-item press, the tab measure and the roadmap open');
  assert.equal(calls['render.js'], 2, 'render.js: the roadmap and dashboard catch-up, beside the helper');
  assert.equal(calls['menu.js'], 1, 'menu.js: the drawer pick');
});

test('clause 2: requestAnimationFrame plus setTimeout appears in one view file only [C7,#9528]', () => {
  const files = SOURCES.filter((file) => file.text.split('\n').some((line) => /requestAnimationFrame|frame\(/u.test(line) && /\(\) => setTimeout\(/u.test(line))).map((file) => file.name);
  assert.deepEqual(files, ['render.js']);
});
