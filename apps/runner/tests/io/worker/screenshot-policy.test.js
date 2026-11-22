/** The public worker capability supplies unchanged rules to the actual screenshot collector [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { workerScreenshotPolicy } from '../../../light.js';
import { workerScreenshotPolicy as entryPolicy } from '../../../src/io/worker/entry.js';
import { collectScreenshots } from '../../../src/io/worker/screenshots.js';
import { screenshotPlan } from '../../../../../packages/runners/light.js';
import { SCREENSHOT_MAX_BYTES } from '../../../../../packages/runners/light.js';
import { SCREENSHOT_DIRECTORY } from '../../../../../packages/runners/light.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';

test('runner.screenshot-policy.canonical-runtime-capability: clause 1: the public capability is the actual worker factory and unchanged planner, cap and directory collect normal PNGs, ignore other paths and preserve bounded refusal [C7]', t => {
  assert.equal(typeof workerScreenshotPolicy, 'function');
  assert.equal(workerScreenshotPolicy, entryPolicy);
  const rules = workerScreenshotPolicy();
  assert.deepEqual(Object.keys(rules).sort(), ['directory', 'maxBytes', 'screenshotPlan']);
  assert.equal(rules.screenshotPlan, screenshotPlan);
  assert.equal(rules.maxBytes, SCREENSHOT_MAX_BYTES);
  assert.equal(rules.directory, SCREENSHOT_DIRECTORY);
  const { root, write } = privateFixtureFiles('worker-policy-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(collectScreenshots(root, workerScreenshotPolicy()), { screenshots: [] });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  write('screenshots/one.png', png); write('screenshots/nested/two.png', png);
  write('screenshots/notes.txt', 'not a PNG'); write('outside.png', png);
  const normal = collectScreenshots(root, workerScreenshotPolicy());
  assert.equal(normal.refused, undefined);
  assert.deepEqual(normal.screenshots.map(row => row.path).sort(), ['screenshots/nested/two.png', 'screenshots/one.png']);
  for (const row of normal.screenshots) {
    assert.equal(row.bytes, png.length);
    assert.equal(row.base64, png.toString('base64'));
    assert.equal(row.sha256, createHash('sha256').update(png).digest('hex'));
  }
  write('screenshots/oversize.png', Buffer.alloc(SCREENSHOT_MAX_BYTES + 1));
  const refused = collectScreenshots(root, workerScreenshotPolicy());
  assert.deepEqual(refused.screenshots, []);
  assert.equal(refused.refused.code, 'SCREENSHOTS_TOO_LARGE');
  assert.ok(refused.refused.message.includes(String(SCREENSHOT_MAX_BYTES + 1 + 2 * png.length)));
  assert.deepEqual(workerScreenshotPolicy(), rules, 'collection did not mutate the canonical policy');
});
