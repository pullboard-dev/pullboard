/** Run an ES-module source in a fresh node process inside a fixture box, for the runner recovery journeys [C7]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../child.js';

/**
 * Execute `source` as an ES module in the box's own environment and return its JSON stdout.
 *
 * Why: a fresh node process proves the module graph loads without the CLI seam; one fixture holds the spawn so journeys count no launch.
 *
 * @param {{ repo: string, env: object }} box - The fixture project.
 * @param {string} source - Module text; it prints one JSON document.
 * @returns {object} The parsed stdout.
 */
export function runModuleChild(box, source) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
