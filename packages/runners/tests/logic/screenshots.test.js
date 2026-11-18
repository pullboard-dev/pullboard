/** A pure plan picks which runner screenshot files come back and refuses an oversize set [C7,#2097]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenshotPlan } from '../../src/logic/screenshots.js';

const FILES = [
  { path: 'screenshots/home.png', bytes: 1200 },
  { path: 'screenshots/nested/detail.png', bytes: 800 },
  { path: 'screenshots/notes.txt', bytes: 10 },
  { path: 'screenshots/photo.PNG.bak', bytes: 10 },
  { path: 'other/home.png', bytes: 500 },
  { path: 'home.png', bytes: 400 },
  { path: 'screenshots/../escape.png', bytes: 300 },
  { path: '../screenshots/outside.png', bytes: 300 },
];

test('runners.logic-screenshots.only-png-in-directory: clause 1: screenshotPlan(files, maxBytes) returns only the .png files inside the declared screenshot directory, each with its size, and ignores every other file [C7]', () => {
  assert.deepEqual(screenshotPlan(FILES, 10_000), [
    { path: 'screenshots/home.png', bytes: 1200 },
    { path: 'screenshots/nested/detail.png', bytes: 800 },
  ]);
  assert.deepEqual(screenshotPlan([], 0), []);
  assert.deepEqual(screenshotPlan([{ path: 'shots/a.png', bytes: 5 }], 5, 'shots'), [{ path: 'shots/a.png', bytes: 5 }]);
});

test('runners.logic-screenshots.refuses-oversize-set: clause 2: screenshotPlan refuses with the total size named when the png files together exceed maxBytes, and never truncates [C7]', () => {
  assert.equal(screenshotPlan(FILES, 2000).length, 2, 'a total exactly at the cap is kept');
  assert.throws(() => screenshotPlan(FILES, 1999), error => error.code === 'SCREENSHOTS_TOO_LARGE' && /2000 bytes/u.test(error.message) && /1999 byte cap/u.test(error.message));
});
