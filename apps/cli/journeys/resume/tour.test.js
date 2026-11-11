/** The tour on a throwaway repo: colours, isolation and the registered demo (N10, N26); split from e2e.test.js to keep each file under two minutes. */
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
import { fetchFresh } from '../../tests/fixtures/http.js';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, sandbox, project, startView,
} = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next --wait 1') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

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
  assert.match(box.git(repo, 'log', '--format=%an %s', '-1'), /^app-1 fix\(app\): a blank name greets the world \[G1\]$/);
  assert.equal(isolated.status, 0, `git settings from the environment stay out: ${isolated.stdout}`);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /The tour stopped: git init -q -b main exited null/);
});

test('the tour registers a labelled demo that view lists and forget removes [N10, N26]', async () => {
  const box = project();
  const tourEnv = { ...box.env, TMPDIR: box.dir, HOME: box.dir };
  delete tourEnv.PULLBOARD_MODEL;
  const result = spawnSync(process.execPath, [BIN, 'tour'], {
    cwd: box.dir,
    env: tourEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(withoutAction(result.stdout, 'pullboard view').trimEnd().split('\n').at(-1), 'see it: pullboard view');
  assert.equal(result.stdout.match(/^next: pullboard view$/gmu)?.length, 1, 'the outer command retains its action');
  assert.doesNotMatch(result.stdout, /^ +next: pullboard next --wait 1$/mu, 'nested child commands add no fallback footers');
  const demoRoot = /Look around: cd (\S+) && pullboard log/.exec(result.stdout)?.[1];
  assert.ok(demoRoot, 'the retained demo path is printed');
  const registered = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registered.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);

  const view = await startView(box, box.repo);
  try {
    const listing = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);
    const forgotten = box.run(box.dir, 'forget', demoRoot);
    assert.equal(forgotten.code, 0, forgotten.err);
    assert.match(forgotten.out, /forgot/);
    const after = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.deepEqual((await after.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo']]);
  } finally {
    await view.stop();
  }
});
