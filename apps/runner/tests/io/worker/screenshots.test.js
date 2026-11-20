/** The runner worker collects a job's png screenshots, hashed and encoded, and refuses an oversize set without reading it [C7,#2097]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { SCREENSHOT_DIRECTORY } from '../../../../../packages/runners/light.js';
import { SCREENSHOT_MAX_BYTES } from '../../../../../packages/runners/light.js';
import { screenshotPlan } from '../../../../../packages/runners/light.js';
import { collectScreenshots as collect } from '../../../src/io/worker/screenshots.js';

const rules = { screenshotPlan, maxBytes: SCREENSHOT_MAX_BYTES, directory: SCREENSHOT_DIRECTORY };
/** collectScreenshots with the runners cell's rules, as entry.js passes them. */
const collectScreenshots = root => collect(root, rules);

test('runner.io-worker-screenshots.collects-pngs: clause 1: collectScreenshots lists the screenshots directory of the checkout, keeps the pngs with their path, bytes, sha256 and base64, and returns an empty list when the directory is absent [C7,#2097]', t => {
  const { root, write } = privateFixtureFiles('pullboard-shots-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(collectScreenshots(root), { screenshots: [] }, 'no directory, no screenshots');
  const one = Buffer.from('first-png-bytes');
  const two = Buffer.from('second-png-bytes!');
  write('screenshots/one.png', one);
  write('screenshots/nested/two.png', two);
  write('screenshots/notes.txt', 'not a png');
  write('elsewhere/three.png', 'outside the directory');
  const { screenshots, refused } = collectScreenshots(root);
  assert.equal(refused, undefined);
  assert.deepEqual(screenshots.map(file => file.path).sort(), ['screenshots/nested/two.png', 'screenshots/one.png']);
  for (const [path, data] of [['screenshots/one.png', one], ['screenshots/nested/two.png', two]]) {
    const row = screenshots.find(file => file.path === path);
    assert.equal(row.bytes, data.length);
    assert.equal(row.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(row.base64, data.toString('base64'));
  }
});

test('runner.io-worker-screenshots.refuses-oversize: clause 2: a set of pngs over SCREENSHOT_MAX_BYTES returns no files and a refusal naming the total bytes [C7,#2097]', t => {
  const { root, write } = privateFixtureFiles('pullboard-shots-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const half = Buffer.alloc(Math.floor(SCREENSHOT_MAX_BYTES / 2) + 1, 1);
  write('screenshots/a.png', half);
  write('screenshots/b.png', half);
  const result = collectScreenshots(root);
  assert.deepEqual(result.screenshots, []);
  assert.equal(result.refused.code, 'SCREENSHOTS_TOO_LARGE');
  assert.ok(result.refused.message.includes(String(half.length * 2)), 'the refusal names the total bytes');
});
