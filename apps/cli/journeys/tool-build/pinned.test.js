/** @pullboard-test-input source-tree */
/** Synthetic tool generations exercise real Git, native full-gate receipts and actual CLI dispatch [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import {
  cleanupFixtureChildren,
  runFixtureChild,
  startFixtureChild,
} from '../../tests/fixtures/child.js';
import { gatedToolBuild } from '../../src/io/pinned/tool/publish.js';
import { scheduleToolBuildGate } from '../../src/io/tool/build.js';
import { runScheduledToolBuildGate } from '../../src/io/tool/build.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { selectedToolEntry } from '../../src/io/pinned/tool/build.js';
import { toolBuildLocation } from '../../src/io/pinned/tool/build.js';
import { toolBuildPolicy } from '../../src/io/pinned/tool/build.js';
import { readToolBuild } from '../../src/io/pinned/tool/build.js';
import { writeToolBuild } from '../../src/io/pinned/tool/build.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
const e2e = createE2eHelpers();
after(async () => {
  await cleanupFixtureChildren();
  for (const directory of e2e.sandboxes) rmSync(directory, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

/** Produce a real native full landing receipt, never a caller-written green proof. */
function gate(box) {
  const module = new URL('../../../../packages/gate/index.js', import.meta.url).href;
  const script = `import {runGate} from ${JSON.stringify(module)};
import {loadConfig} from ${JSON.stringify(new URL('../../../../packages/config/src/io/main.js', import.meta.url).href)};
${executionServicesSource(module)}
const result=await runGate(process.cwd(),loadConfig(process.cwd()),{executionServices,trustStamp:false,landing:true,agent:'coordinator'});
if(!result.isGreen)throw Error(result.output);console.log(JSON.stringify({id:result.receiptId}));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.failure ?? child.stderr + child.stdout);
  return JSON.parse(child.stdout.trim().split('\n').at(-1)).id;
}

/** Commit a complete installable synthetic generation with the ordinary hooks still enabled. */
function generation(box, label) {
  writeFileSync(join(box.repo, 'apps/cli/src/io/commands/status.js'), `/** Synthetic generation probe for the pin integration fixture. */
import {existsSync,writeFileSync} from 'node:fs';
export const nativeBoardRequired = false;
export async function run(io){
 if(process.env.PULLBOARD_PIN_READY)writeFileSync(process.env.PULLBOARD_PIN_READY,'ready');
 while(process.env.PULLBOARD_PIN_RELEASE&&!existsSync(process.env.PULLBOARD_PIN_RELEASE))await new Promise(resolve=>setTimeout(resolve,10));
 io.say('${label}');return 0;
}
`);
  const hookFile = join(box.repo, 'apps/cli/src/io/commands/hook.js');
  const originalHook = box.originalHook;
  writeFileSync(hookFile, `import {writeFileSync as writePinHookMarker} from 'node:fs';\nif(process.env.PULLBOARD_PIN_HOOK_MARKER)writePinHookMarker(process.env.PULLBOARD_PIN_HOOK_MARKER,'${label}');\n${originalHook}`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', `chore: synthetic tool generation ${label}`);
  return box.git(box.repo, 'rev-parse', 'HEAD').trim();
}

/** Observe an owned fixture boundary without retrying any product assertion. */
async function ready(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, 'the actual pinned command reached its waiting boundary');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Install source before normal board initialization, as a real installation precedes installing its hooks. */
function project(source) {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  copyPackageFiles(source, repo);
  mkdirSync(join(repo, 'test'), { recursive: true });
  const originalHook = readFileSync(join(repo, 'apps/cli/src/io/commands/hook.js'), 'utf8');
  // This private project has one committed test; copied package and app fixtures are not its tests.
  for (const name of readdirSync(join(repo, 'packages'))) rmSync(join(repo, 'packages', name, 'tests'), { recursive: true, force: true });
  for (const name of readdirSync(join(repo, 'apps'))) rmSync(join(repo, 'apps', name, 'tests'), { recursive: true, force: true });
  mkdirSync(join(repo, 'packages/gate/tests/fixtures'), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../../../../packages/gate/tests/fixtures/budgets.js'), join(repo, 'packages/gate/tests/fixtures/budgets.js'));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-qm', 'chore: install synthetic tool source before board initialization');
  const initialized = box.run(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err + initialized.out);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node packages/gate/src/io/run/tests.js',
    verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: ['docs/'] }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo spec\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: web test\n');
  return { ...box, repo, originalHook };
}

test('pinned CLI, hooks and loaded generation survive trunk advancement; native promotion affects new commands only [C7]', async () => {
  const source = resolve(import.meta.dirname, '../../../..');
  const box = project(source);
  mkdirSync(join(box.repo, 'apps/cli/tests'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/tests/pin-audit.test.js'), "import { test } from 'node:test'; test('synthetic full gate [C7]',()=>{});\n");
  const first = generation(box, 'first');
  const location = toolBuildLocation(box.repo);
  assert.equal(toolBuildPolicy(location).enabled, false);
  assert.equal(await selectedToolEntry(box.repo, join(source, 'apps/cli/pullboard.js')), null, 'default off preserves the existing dispatcher');
  const firstReceipt = gate(box);
  const fullBuild = gatedToolBuild(location, first, firstReceipt);
  assert.equal(fullBuild.commit, first, 'the native full main run is eligible');
  assert.throws(() => gatedToolBuild(location, first, firstReceipt, { now: Date.parse(fullBuild.gatedAt) + 3_600_001 }),
    { code: 'TOOL_BUILD_STALE' }, 'an actual full receipt older than the refresh window is named and refused');
  assert.throws(() => gatedToolBuild(location, first, '11111111-1111-4111-8111-111111111111'), { code: 'TOOL_BUILD_NOT_GATED' });
  let result = box.run(box.repo, 'tool-build', 'promote', first, '--gate-receipt', firstReceipt, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const seat = join(box.dir, 'claimed-seat');
  box.git(box.repo, 'worktree', 'add', '--detach', seat, first);
  result = fixtureJoin(box.run, seat, 'web', '--family', 'Synthetic independent pin fixture');
  assert.equal(result.code, 0, result.err + result.out);
  result = fixtureAdd(box.run, box.repo, 'web', 'Synthetic held source', '--criterion', 'Keep the held source unchanged', '--specs', 'G1', '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const item = JSON.parse(result.out).item.item_id;
  result = box.run(seat, 'claim', String(item), '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.toolBuild = { enabled: true, refreshMs: 3_600_000 };
  writeFileSync(configFile, JSON.stringify(config));
  const second = generation(box, 'second');
  const secondReceipt = gate(box);
  assert.throws(() => gatedToolBuild(location, first, secondReceipt), { code: 'TOOL_BUILD_NOT_GATED' });
  // Version-only arguments intentionally bypass pinned-tool selection; probe an ordinary command to test the selected generation.
  assert.equal(box.run(seat, 'status', '--name', 'tool-probe').out.trim().split('\n')[0], 'first', 'a new trunk commit does not move the claimed seat CLI');
  const hookMarker = join(box.dir, 'hook-generation');
  const hook = runFixtureChild(process.execPath, [join(source, 'apps/cli/pullboard.js'), 'hook', 'pre-commit'],
    { cwd: seat, env: { ...box.env, PULLBOARD_PIN_HOOK_MARKER: hookMarker }, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.failure ?? hook.stderr + hook.stdout);
  assert.equal(readFileSync(hookMarker, 'utf8'), 'first', 'actual hook implementation comes from the selected generation');
  assert.equal(readToolBuild(location).commit, first, 'the actual hook command retained the same published build');
  const marker = join(box.dir, 'pin-ready'), release = join(box.dir, 'pin-release');
  const held = startFixtureChild(process.execPath, [join(source, 'apps/cli/pullboard.js'), 'status', '--name', 'tool-probe'],
    { cwd: seat, env: { ...box.env, PULLBOARD_PIN_READY: marker, PULLBOARD_PIN_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  held.stdout.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => held.on('close', resolve));
  try {
    await ready(marker);
    result = box.run(box.repo, 'tool-build', 'promote', second, '--gate-receipt', secondReceipt, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    assert.equal(box.run(seat, 'status', '--name', 'tool-probe').out.trim().split('\n')[0], 'second', 'promotion changes the next command');
    assert.equal(box.git(seat, 'rev-parse', 'HEAD').trim(), first, 'tool promotion does not advance the item source');
    writeFileSync(release, 'release');
    const code = await closed;
    assert.equal(code, 0);
    assert.equal(output.trim().split('\n')[0], 'first', 'the already running command finishes from its own immutable generation');
    assert.equal(readToolBuild(location).commit, second);
    const health = JSON.parse(box.run(seat, 'health', '--json').out);
    assert.equal(health.toolBuild.runningCommit, second);
    assert.ok(health.toolBuild.ageMs >= 0);
    result = box.run(seat, 'tool-build', 'promote', first, '--gate-receipt', firstReceipt, '--json');
    assert.equal(JSON.parse(result.out).error.code, 'COORDINATOR_ONLY');
    result = box.run(box.repo, 'tool-build', 'promote', first, '--gate-receipt', firstReceipt, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    const prior = readToolBuild(location);
    writeToolBuild(location, { ...prior, promotedAt: new Date(Date.now() - 3_600_001).toISOString() });
    const selected = await selectedToolEntry(seat, join(source, 'apps/cli/pullboard.js'));
    assert.equal(selected, join(location.directory, second, 'apps/cli/pullboard.js'), 'hourly refresh selects native gated accepted source at the next command boundary');
  } finally { writeFileSync(release, 'release'); await closed; }
});

test('a native green selected-file gate cannot publish a full tool build [C7]', () => {
  const box = project(resolve(import.meta.dirname, '../../../..'));
  mkdirSync(join(box.repo, 'apps/cli/tests'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/tests/pin-audit.test.js'), "import { test } from 'node:test'; test('selected fixture [C7]',()=>{});\n");
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.gate = 'node packages/gate/src/io/run/tests.js apps/cli/tests/pin-audit.test.js';
  writeFileSync(configFile, JSON.stringify(config));
  const commit = generation(box, 'partial');
  const receipt = gate(box);
  assert.throws(() => gatedToolBuild(toolBuildLocation(box.repo), commit, receipt), { code: 'TOOL_BUILD_NOT_GATED' },
    'a real green selected-file receipt cannot be treated as a full run');
});

test('automatic main gate is opt-in and refuses an unregistered timer [C7]', async () => {
  assert.equal(configFromSource('{}').toolBuild.autoGate, false);
  assert.equal(configFromSource('{"toolBuild":{"enabled":false,"autoGate":true}}').toolBuild.autoGate, true);
  assert.throws(() => configFromSource('{"toolBuild":{"autoGate":"yes"}}'), { code: 'BAD_CONFIG' });
  assert.deepEqual(await scheduleToolBuildGate({ config: { toolBuild: { autoGate: false } } }), { scheduled: false, reason: 'disabled' });
  assert.deepEqual(await runScheduledToolBuildGate({}, 'not-a-native-token'), { ran: false, reason: 'unregistered' });
});

test('timer honors committed main opt-out and retains an observed live owner [C7]', async () => {
  const box = project(resolve(import.meta.dirname, '../../../..'));
  mkdirSync(join(box.repo, 'apps/cli/tests'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/tests/pin-audit.test.js'), "import { test } from 'node:test'; test('timer source [C7]',()=>{});\n");
  generation(box, 'timer');
  const commonDir = realpathSync(box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const ctx = { info: { root: box.repo, commonDir }, config: { toolBuild: { autoGate: true } } };
  assert.deepEqual(await scheduleToolBuildGate(ctx), { scheduled: false, reason: 'disabled-on-main' });
  const directory = join(commonDir, 'pullboard', 'tool-build-scheduler');
  assert.equal(existsSync(directory), false, 'a stale caller cannot create a timer while main opts out');
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.toolBuild = { enabled: false, autoGate: true, refreshMs: 3_600_000 };
  writeFileSync(path, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'test: opt into private timer');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
  const started = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
    { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim().split(/\s+/u).join(' ');
  const owner = { version: 1, token: randomUUID(), pid: process.pid, started,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: realpathSync(box.repo), common: commonDir };
  const marker = join(directory, 'timer.json'), bytes = JSON.stringify(owner) + '\n';
  writeFileSync(marker, bytes, { mode: 0o600 });
  assert.equal((await scheduleToolBuildGate(ctx)).reason, 'existing-timer');
  assert.equal(readFileSync(marker, 'utf8'), bytes, 'a live native identity is not replaced or signalled');
});
