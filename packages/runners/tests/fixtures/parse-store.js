/** A fresh process that parses with a kept compiler store, for cross-process cache tests [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PARSER = new URL('../../src/io/module/parser.js', import.meta.url).href;

/**
 * Parse one source in a fresh process that keeps results (as a short controller does) and return its compile count.
 *
 * Why a process: the store is read across processes, so only a new one proves a later controller reuses it. `shared`
 * names a runner's shared cache; without it the process keeps a private store under `scratch`.
 */
export function compiledIn(scratch, source, shared = null) {
  const script = `const { createRunnerModuleParser, keepParserResults, runnerModuleParserCompileCount } = await import(${JSON.stringify(PARSER)});
keepParserResults();
const parser = createRunnerModuleParser();
const [row] = parser.parse([${JSON.stringify(source)}]);
parser.close();
process.stdout.write(JSON.stringify({ count: runnerModuleParserCompileCount(), imports: row.imports }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: jobEnvironment(scratch, shared), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/** A process environment with its own scratch and, only when named, a runner's shared cache folder. */
function jobEnvironment(scratch, shared) {
  const env = { ...process.env, PULLBOARD_SCRATCH: scratch };
  delete env.PULLBOARD_RUNNER_SHARED_CACHE;
  return shared ? { ...env, PULLBOARD_RUNNER_SHARED_CACHE: shared } : env;
}
