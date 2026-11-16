/** Run a printed `pullboard ...` line as the person would paste it, for the init gate journeys [C7]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from './child.js';

/**
 * Run a printed `pullboard ...` line as the person would paste it: a real shell parses its words, and the production CLI
 * answers them in this process. Why: a node start-up per setter cost seconds on a loaded runner; the shell still proves the quoting [C7].
 */
export async function runPrinted(box, cwd, line) {
  const words = runFixtureChild('sh', ['-c', `pullboard() { printf '%s\\0' "$@"; }\n${line}`], { cwd, env: box.env, encoding: 'utf8' });
  assert.equal(words.status, 0, words.failure || words.stderr);
  return box.runLocal(cwd, ...words.stdout.split('\0').slice(0, -1));
}
