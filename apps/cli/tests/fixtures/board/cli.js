/** Run one CLI command with captured output and check its JSON result shape [A1]. */
import assert from 'node:assert/strict';
import { main } from '../native.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';

/**
 * Run one CLI command with captured text and JSON output streams.
 *
 * @param {string} cwd
 * @param {string[]} argv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runMain(cwd, argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

/**
 * Check every required top-level JSON result field against the shared CLI catalog.
 *
 * @param {any} result
 * @param {string} command
 */
export function assertJsonShape(result, command) {
  for (const [key, type] of Object.entries(JSON_SHAPES.commands[command].required)) {
    const correct = type === 'array' ? Array.isArray(result[key]) : typeof result[key] === type;
    assert.equal(correct, true, `${command} JSON field ${key}`);
  }
}

