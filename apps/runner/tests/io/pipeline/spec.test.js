/**
 * Repro, #3884 and RUNNER_REQUEST_LIMIT on #3578, #3588 and #3878 (8 Nov): the runner work spec inlined the worker's
 * runtime sources, so once the worker code reached 1 MB every request passed its 1 MiB frame and no gate could reach a
 * runner. The invariant: a runner request for this repository's own tests, a shard naming every test file at once,
 * builds a spec under 1 MiB [C7]. Fails on 2640738102^ (the request is refused RUNNER_REQUEST_LIMIT); passes after it.
 *
 * The request is built for a scratch copy of the tree under test, in its own process; nothing is sent to any runner.
 */
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  committedCopy,
  gitIn,
  guardProcesses,
  hopCheck,
  runModuleSource,
  scratch,
  within,
} from '../../../../../packages/gate/tests/fixtures/pipeline/kit.js';

/** The runner request frame bound requestFor enforces. */
const SPEC_LIMIT = 1024 ** 2;

guardProcesses();

test('runner.spec.a-runner-request-naming-every-test-file: a runner request naming every test file of this repository builds a spec under 1 MiB [C7]', { timeout: 300_000 }, async () => {
  const dir = await scratch('runner-spec');
  const repo = committedCopy(ROOT, join(dir, 'repo'));
  const files = gitIn(repo, 'ls-files', '*.test.js').split('\n').filter(Boolean);
  const command = `node apps/cli/src/io/run/tests.js ${files.join(' ')}`;
  const source = `
    import { requestFor, trustedTooling } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/runners/index.js')).href)};
    import { privateCheckEnvelope } from ${JSON.stringify(pathToFileURL(join(ROOT, 'apps/runner/src/io/private/guard.js')).href)};
    const commit = process.argv[1], tree = process.argv[2], command = process.argv[3];
    const runtime = trustedTooling().runtime;
    const inlined = Object.values(runtime.files ?? {}).reduce((sum, text) => sum + Buffer.byteLength(String(text)), 0);
    const started = performance.now();
    try {
      const request = await requestFor(process.cwd(), command, { runner: { host: 'hop-harness-runner', slots: 1, browser: 0 },
        source: { commit, tree }, metadata: { item: 'fixture', kind: 'remote-command' } }, { privateCheckEnvelope });
      try { process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(request.spec)), inlined, ms: performance.now() - started })); }
      finally { request.cleanup(); }
    } catch (error) {
      process.stdout.write(JSON.stringify({ refused: error.code ?? error.name, message: error.message, inlined, ms: performance.now() - started }));
    }`;
  await hopCheck('runner-spec', async () => {
    const run = runModuleSource(source, [gitIn(repo, 'rev-parse', 'HEAD'), gitIn(repo, 'rev-parse', 'HEAD^{tree}'), command],
      { cwd: repo, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PULLBOARD_TEST_REUSE: '0' } });
    if (run.status !== 0) throw new Error(`request builder exited ${run.status}: ${run.stderr.slice(0, 400)}`);
    const result = JSON.parse(run.stdout);
    const kib = bytes => `${Math.round(bytes / 1024)} KiB`;
    const measured = { ms: result.ms, measured: result.refused
      ? `refused ${result.refused} for ${files.length} files (runtime sources ${kib(result.inlined)})`
      : `spec ${kib(result.bytes)} for ${files.length} files; runtime sources ${kib(result.inlined)} travel by digest` };
    within(!result.refused && result.bytes < SPEC_LIMIT, `the runner spec stays under ${SPEC_LIMIT} bytes`, measured);
    return measured;
  });
});
