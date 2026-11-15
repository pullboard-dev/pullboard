/** A fresh process that parses with a kept compiler store, for cross-process cache tests [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PARSER = new URL('../../src/io/module/parser.js', import.meta.url).href;

/**
 * Parse one source in a fresh process that keeps results (as a short controller does) and return its compile count.
 *
 * Why a process: the store is read across processes, so only a new one proves a later controller reuses it.
 */
export function compiledIn(scratch, source) {
  const script = `const { createRunnerModuleParser, keepParserResults, runnerModuleParserCompileCount } = await import(${JSON.stringify(PARSER)});
keepParserResults();
const parser = createRunnerModuleParser();
const [row] = parser.parse([${JSON.stringify(source)}]);
parser.close();
process.stdout.write(JSON.stringify({ count: runnerModuleParserCompileCount(), imports: row.imports }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PULLBOARD_SCRATCH: scratch }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
