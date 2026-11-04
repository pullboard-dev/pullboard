/** A known-main red is fully collected with later selected files before landing compares it [B3,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { runFixtureChild } from './fixture-child.js';
import { failureSignatures } from '../packages/landing/src/shell/main-failure-matches.js';

const SOURCE = resolve(import.meta.dirname, '..');

/** A committed two-file project whose gate invokes the real Node test runner. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-known-main-complete-'));
  const repo = join(dir, 'repo'), home = join(dir, 'home'), machine = join(home, '.pullboard');
  mkdirSync(machine, { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  copyPackageFiles(SOURCE, repo);
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { memoryFloorMB: 0 } }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Known Main Fixture',
    GIT_AUTHOR_EMAIL: 'known-main@example.invalid', GIT_COMMITTER_NAME: 'Known Main Fixture', GIT_COMMITTER_EMAIL: 'known-main@example.invalid' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING)/u.test(key)) delete env[key];
  writeFileSync(join(repo, 'test/early.test.js'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('existing main failure', () => assert.fail('main red'));");
  writeFileSync(join(repo, 'test/later.test.js'), `import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('later selected pass', () => writeFileSync(${JSON.stringify(join(dir, 'later-ran'))}, 'ran'));`);
  const wrapper = join(dir, 'gate.cjs');
  writeFileSync(wrapper, `const { spawnSync } = require('node:child_process'); const files = process.argv.slice(2); let status = 0;\nfor (let i=0; i<files.length; i++) { const run = spawnSync(process.execPath, ['--test','--test-reporter=tap',files[i]], { encoding:'utf8' }); process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || ''); status ||= run.status || 1; if (run.status && process.env.PULLBOARD_LANDING_COLLECT_ALL !== '1') { for (const skipped of files.slice(i+1)) process.stdout.write('Interrupted test files: ' + skipped + '\\n'); break; } } process.exitCode = status;`);
  const git = (...args) => {
    const result = runFixtureChild('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `node ${JSON.stringify(wrapper)} ./test/early.test.js ./test/later.test.js`, affectedTests: `node ${JSON.stringify(wrapper)}` }));
  git('add', '-A'); git('commit', '-q', '-m', 'test: known-main red with later selected pass');
  return { dir, repo, env, git };
}

/** Execute the fixture's native landing gate and return its complete run. */
function landingGate(box) {
  const gateUrl = pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href;
  const configUrl = pathToFileURL(join(SOURCE, 'packages/config/index.js')).href;
  const landingUrl = pathToFileURL(join(SOURCE, 'packages/landing/src/shell/landing-shards.js')).href;
  const runnersUrl = pathToFileURL(join(SOURCE, 'packages/runners/index.js')).href;
  const script = `import { runGate } from ${JSON.stringify(gateUrl)}; import { loadConfig } from ${JSON.stringify(configUrl)}; import { landingExecutionServices } from ${JSON.stringify(landingUrl)}; import { runnerExecutionServices } from ${JSON.stringify(runnersUrl)}; const root=${JSON.stringify(box.repo)}; const run=await runGate(root,loadConfig(root),{ landing:true, collectAll:true, trustStamp:false, executionServices:{ landing:landingExecutionServices(), runners:runnerExecutionServices() } }); process.stdout.write(JSON.stringify({isGreen:run.isGreen, complete:run.collectAllComplete, output:run.output}));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('landing completes an early known-main red and later selected pass; a new red still blocks [B3,C7]', { timeout: 120_000 }, t => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const known = landingGate(box);
  assert.equal(known.isGreen, false, 'the known-main test remains red');
  assert.equal(known.complete, true, 'every selected file has a complete native run account');
  assert.ok(readFileSync(join(box.dir, 'later-ran'), 'utf8'), 'the later selected test body ran');
  assert.doesNotMatch(known.output, /Interrupted test files:|Landing gate stopped early/u);
  assert.deepEqual(failureSignatures({ output: known.output }, box.repo).map(row => [row.file, row.name]),
    [['test/early.test.js', 'existing main failure']]);

  writeFileSync(join(box.repo, 'test/later.test.js'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('new batch failure', () => assert.fail('new red'));");
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'test: introduce a new selected red');
  const changed = landingGate(box);
  assert.equal(changed.isGreen, false, 'a new red never becomes green');
  assert.equal(changed.complete, true, 'the new red is still fully accounted');
  assert.deepEqual(failureSignatures({ output: changed.output }, box.repo).map(row => row.name), ['existing main failure', 'new batch failure']);
});
