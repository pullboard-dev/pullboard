/** The tour on a throwaway repo: colours, isolation and the registered demo (N10); split from e2e.test.js to keep each file under two minutes. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  runFixtureChild as spawnSync,
  runFixtureChildAsync,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, sandbox,
} = e2e;

test('the tour runs a reject and its rework on a throwaway repo, in under thirty seconds [N10]', async () => {
  const box = sandbox();
  const plainEnv = { ...box.env, TMPDIR: box.dir };
  delete plainEnv.NO_COLOR;
  delete plainEnv.FORCE_COLOR;
  const started = Date.now();
  const shown = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: plainEnv, encoding: 'utf8' });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  const slowest = shown.stderr.split('\n').find((line) => line.startsWith('slowest steps:')) ?? 'the tour named no slowest steps';
  assert.ok(Date.now() - started < 30_000, `thirty seconds; ${slowest}`); // budget: approved row N10 states thirty seconds.
  assert.doesNotMatch(shown.stdout, /\u001b\[/, 'piped output stays plain');
  assert.match(shown.stdout, /review-1 \(Scripted\) \$ pullboard verify 1 reject --reason BEHAVIOR_MISMATCH/);
  assert.match(shown.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1 \(Scripted\): greet\(''\) returns "Hello, !"/);
  assert.match(shown.stdout, /with the fix removed\n {7}# pass 1\n {7}# fail 1/);
  assert.match(shown.stdout, /verified #1: CRITERION_MET/);
  assert.match(shown.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \(Scripted\) \| review-1 \(Scripted\) \|/);

  // The four variant tours are independent of each other and of the timed plain run above, so they share one wall-clock window.
  const hooks = join(box.dir, 'ambient-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho ambient hook ran >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const ambient = { ...plainEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, GIT_DIR: join(box.dir, 'elsewhere.git') };
  const empty = join(box.dir, 'empty');
  mkdirSync(empty);
  const tour = (env) => runFixtureChildAsync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env });
  const [forced, noColor, isolated, stopped] = await Promise.all([
    tour({ ...plainEnv, FORCE_COLOR: '1' }),
    tour({ ...plainEnv, FORCE_COLOR: '1', NO_COLOR: '1' }),
    tour(ambient),
    tour({ ...plainEnv, PATH: empty }),
  ]);
  assert.equal(forced.status, 0, `${forced.stdout}${forced.stderr}`);
  assert.match(forced.stdout, /\u001b\[1m1  The person approved one spec row\. The coordinator files it as work\.\u001b\[0m/);
  assert.match(forced.stdout, /\u001b\[36mcoordinator \(unknown\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[33mapp-1 \(Scripted\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[35mreview-1 \(Scripted\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[31m[^\n]*rejected #1/);
  assert.match(forced.stdout, /\u001b\[31m[^\n]*# fail 1/);
  assert.match(forced.stdout, /\u001b\[32m[^\n]*verified #1: CRITERION_MET/);
  assert.match(forced.stdout, /\u001b\[32m[^\n]*# pass 2/);

  assert.equal(noColor.status, 0, `${noColor.stdout}${noColor.stderr}`);
  assert.doesNotMatch(noColor.stdout, /\u001b\[/, 'NO_COLOR wins even if the environment could otherwise force color');
  const normalizeTourRoot = (text) => text
    .replace(/Look around: cd .* && pullboard log/, 'Look around: cd <tour> && pullboard log')
    .replace(/\b[0-9a-f]{12}\b/g, '<sha>')
    .replace(/claimed #1 until \S+ criterion frozen/g, 'claimed #1 until <time> criterion frozen')
    // A gate's rounded wall time is not output NO_COLOR could change, so a slower gate must still compare equal.
    .replace(/gate (green|red) in \d+s/g, 'gate $1 in <n>s')
    .replace(/\b(wall|slot wait) [0-9.]+s/g, '$1 <n>s');
  assert.equal(normalizeTourRoot(noColor.stdout), normalizeTourRoot(shown.stdout), 'NO_COLOR preserves the plain tour output');

  const repo = /Look around: cd (\S+) && pullboard log/.exec(shown.stdout)[1];
  assert.match(box.git(repo, 'log', '--no-merges', '--format=%an %s', '-1'), /^app-1 fix\(app\): a blank name greets the world \[G1\]$/);
  assert.equal(isolated.status, 0, `git settings from the environment stay out: ${isolated.stdout}`);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /The tour stopped: git init -q -b main exited null/);
});
