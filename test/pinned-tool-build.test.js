/** @pullboard-test-input source-tree */
/** Synthetic tool generations exercise real Git, native full-gate receipts and actual CLI dispatch [C7]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { executionServicesSource } from './gate-execution-fixture.js';
import { runFixtureChild, startFixtureChild } from './fixture-child.js';
import { gatedToolBuild } from '../src/pinned-tool-publish.js';
import { selectedToolEntry, toolBuildLocation, toolBuildPolicy, readToolBuild } from '../src/pinned-tool-build.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Produce a real native full landing receipt, never a caller-written green proof. */
function gate(box) {
  const module = new URL('../src/gate.js', import.meta.url).href;
  const script = `import {runGate} from ${JSON.stringify(module)};
import {loadConfig} from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
${executionServicesSource(module)}
const result=await runGate(process.cwd(),loadConfig(process.cwd()),{executionServices,trustStamp:false,landing:true,agent:'coordinator'});
if(!result.isGreen)throw Error(result.output);console.log(JSON.stringify({id:result.receiptId}));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.failure ?? child.stderr + child.stdout);
  return JSON.parse(child.stdout.trim().split('\n').at(-1)).id;
}

/** Commit a complete installable synthetic generation with the ordinary hooks still enabled. */
function generation(box, label) {
  writeFileSync(join(box.repo, 'src', 'commands', 'version.js'), `/** Synthetic generation probe for the pin integration fixture. */
import {existsSync,writeFileSync} from 'node:fs';
import packageData from '../../package.json' with {type:'json'};
/** Retain this loaded generation while the fixture promotes another build. */
export async function run(io){
 if(!process.argv.includes('tool-probe')){io.say(packageData.version);return 0;}
 if(process.env.PULLBOARD_PIN_READY)writeFileSync(process.env.PULLBOARD_PIN_READY,'ready');
 while(process.env.PULLBOARD_PIN_RELEASE&&!existsSync(process.env.PULLBOARD_PIN_RELEASE))await new Promise(resolve=>setTimeout(resolve,10));
 io.say('${label}');return 0;
}
`);
  const hookFile = join(box.repo, 'src', 'commands', 'hook.js');
  const originalHook = readFileSync(new URL('../src/commands/hook.js', import.meta.url), 'utf8');
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
  for (const name of ['bin', 'src', 'packages', 'package.json']) cpSync(join(source, name), join(repo, name), { recursive: true });
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-qm', 'chore: install synthetic tool source before board initialization');
  const initialized = box.run(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err + initialized.out);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node --test --test-reporter=tap pin-audit.test.cjs',
    verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: ['docs/'] }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo spec\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: web test\n');
  return { ...box, repo };
}

test('pinned CLI, hooks and loaded generation survive trunk advancement; native promotion affects new commands only [C7]', async () => {
  const source = resolve(import.meta.dirname, '..');
  const box = project(source);
  writeFileSync(join(box.repo, 'pin-audit.test.cjs'), "require('node:test').test('synthetic full gate [C7]',()=>{});\n");
  const first = generation(box, 'first');
  const location = toolBuildLocation(box.repo);
  assert.equal(toolBuildPolicy(location).enabled, false);
  assert.equal(await selectedToolEntry(box.repo, join(source, 'bin', 'pullboard.js')), null, 'default off preserves the existing dispatcher');
  const firstReceipt = gate(box);
  assert.throws(() => gatedToolBuild(location, first, '11111111-1111-4111-8111-111111111111'), { code: 'TOOL_BUILD_NOT_GATED' });
  let result = box.run(box.repo, 'tool-build', 'promote', first, '--gate-receipt', firstReceipt, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const seat = join(box.dir, 'claimed-seat');
  box.git(box.repo, 'worktree', 'add', '--detach', seat, first);
  result = box.run(seat, 'join', 'web', '--family', 'Synthetic independent pin fixture');
  assert.equal(result.code, 0, result.err + result.out);
  result = box.run(box.repo, 'add', 'web', 'Synthetic held source', '--criterion', 'Keep the held source unchanged', '--specs', 'G1', '--json');
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
  assert.equal(box.run(seat, 'version', '--name', 'tool-probe').out.trim().split('\n')[0], 'first', 'a new trunk commit does not move the claimed seat CLI');
  const hookMarker = join(box.dir, 'hook-generation');
  const hook = runFixtureChild(process.execPath, [join(source, 'bin', 'pullboard.js'), 'hook', 'pre-commit'],
    { cwd: seat, env: { ...box.env, PULLBOARD_PIN_HOOK_MARKER: hookMarker }, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.failure ?? hook.stderr + hook.stdout);
  assert.equal(readFileSync(hookMarker, 'utf8'), 'first', 'actual hook implementation comes from the selected generation');
  assert.equal(readToolBuild(location).commit, first, 'the actual hook command retained the same published build');
  const marker = join(box.dir, 'pin-ready'), release = join(box.dir, 'pin-release');
  const held = startFixtureChild(process.execPath, [join(source, 'bin', 'pullboard.js'), 'version', '--name', 'tool-probe'],
    { cwd: seat, env: { ...box.env, PULLBOARD_PIN_READY: marker, PULLBOARD_PIN_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  held.stdout.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => held.on('close', resolve));
  try {
    await ready(marker);
    result = box.run(box.repo, 'tool-build', 'promote', second, '--gate-receipt', secondReceipt, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    assert.equal(box.run(seat, 'version', '--name', 'tool-probe').out.trim().split('\n')[0], 'second', 'promotion changes the next command');
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
    const selected = await selectedToolEntry(seat, join(source, 'bin', 'pullboard.js'),
      { now: Date.parse(readToolBuild(location).promotedAt) + 3_600_001 });
    assert.equal(selected, join(location.directory, second, 'bin', 'pullboard.js'), 'hourly refresh selects native gated accepted source at the next command boundary');
  } finally { writeFileSync(release, 'release'); await closed; }
});
