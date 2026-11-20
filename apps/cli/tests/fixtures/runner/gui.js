/** @pullboard-module-loads packages/gate/index.js packages/config/src/io/main.js */
/** Real private SSH/worker fixtures for registration-time desktop observations [C7,V4]. */
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import { runFixtureChildAsync } from '../child.js';
import {
  HOST,
  installSshStandIn,
} from './ssh.js';
import {
  awaitRoundTrip,
  cleanupToolingSnapshots,
  cli,
  committedToolingSnapshot,
  gateResult,
  git,
  phaseCounts,
} from './tooling.js';

/** Simulate only the remote OS's desktop boundary; all SSH, Node and worker code still executes. */
export function registrationGuiFixture(t, mode = 'present') {
  const directory = realpathSync(mkdtempSync('/tmp/pb-gui-reg-'));
  t.after(() => { cleanupToolingSnapshots(); rmSync(directory, { recursive: true, force: true }); });
  const paths = Object.fromEntries(['repo', 'worker', 'bin', 'home', 'machine', 'remoteHome', 'remoteMachine']
    .map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const requests = join(directory, 'requests.jsonl');
  const marker = join(directory, 'gui-body-ran');
  const modeFile = join(directory, 'desktop-mode');
  const preload = join(directory, 'desktop.cjs');
  writeFileSync(modeFile, mode);
  writeFileSync(preload, `const fs=require('node:fs');const cp=require('node:child_process');
const original=cp.spawnSync;
Object.defineProperty(process,'platform',{value:'darwin'});
cp.spawnSync=function(command,...args){
  if(command!=='/bin/launchctl')return original.call(this,command,...args);
  const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');
  return mode==='present'?{status:0,signal:null}:mode==='absent'
    ?{status:113,signal:null,stderr:'Could not find domain for fixture\\n'}
    :{status:125,signal:null,stderr:'Could not print domain: unsupported\\n'};
};
require('node:module').syncBuiltinESMExports();
`);
  const env = { ...process.env, HOME: paths.home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: paths.home,
    PULLBOARD_MACHINE_HOME: paths.machine, PATH: `${paths.bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'GUI registration fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'GUI registration fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_PATH', 'PULLBOARD_GATE_SLOT_HELD',
    'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  writeFileSync(join(paths.machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
  git(paths.repo, env, 'init', '-q', '-b', 'main');
  mkdirSync(join(paths.repo, 'test'));
  writeFileSync(join(paths.repo, 'pullboard.json'), JSON.stringify({ gate: 'node --test test/gui.test.mjs' }));
  writeFileSync(join(paths.repo, 'test/gui.test.mjs'), `/** @pullboard-test-gui */
import {test} from 'node:test';import {writeFileSync} from 'node:fs';
test('first GUI-marked body actually executes [C7]',()=>writeFileSync(${JSON.stringify(marker)},'actual body'));
`);
  git(paths.repo, env, 'add', '-A');
  git(paths.repo, env, 'commit', '-q', '-m', 'test: prepare GUI registration project [C7]');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome,
    machineHome: paths.remoteMachine, requests, nodeOptions: `--require=${preload}`, registrationNodeOptions: `--require=${preload}` });
  /** Parse only the stand-in's durable transport observations, never a synthesized gate result. */
  const trace = suffix => existsSync(requests + suffix)
    ? readFileSync(requests + suffix, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  /** Register through the public CLI in a fresh process and read its actual result. */
  const register = () => {
    const result = cli(paths.repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
    assert.equal(result.status, 0, result.context);
    return JSON.parse(result.stdout).runner;
  };
  /** Register again and return the raw CLI result, for a registration that is expected to refuse. */
  const registerRaw = () => cli(paths.repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  /** Run the ordinary gate with real GUI-marker classification and no previous worker receipt. */
  const runGui = async () => {
    for (const [name, value] of [['browserSlots', '0'], ['gateSlots', '0']]) {
      const result = cli(paths.repo, env, 'settings', name, value);
      assert.equal(result.status, 0, result.context);
    }
    const tooling = committedToolingSnapshot(fileURLToPath(new URL('../../../../..', import.meta.url)), env);
    const gate = pathToFileURL(join(tooling, 'packages/gate/index.js')).href;
    const config = pathToFileURL(join(tooling, 'packages/config/src/io/main.js')).href;
    const source = `import {runGate} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import {loadConfig} from ${JSON.stringify(config)};
const root=${JSON.stringify(paths.repo)};
const result=await runGate(root,loadConfig(root),{ executionServices,trustStamp:false});
process.stdout.write(result.output);
process.stdout.write('PULLBOARD_RUN_RESULT '+JSON.stringify({isGreen:result.isGreen,runner:result.profile.executionRunner,profile:result.profile})+'\\n');
process.exitCode=result.isGreen?0:1;
`;
    const phases = requests + '.phases';
    const before = phaseCounts(phases);
    const closed = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source],
      { cwd: paths.repo, env, detached: true });
    return awaitRoundTrip(closed.child, closed, phases, before);
  };
  return { ...paths, directory, requests, marker, env, register, registerRaw, trace, runGui,
    setMode: value => writeFileSync(modeFile, value),
    transportDown: () => installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome,
      machineHome: paths.remoteMachine, requests, healthDown: true, registrationDown: true }),
    list: () => JSON.parse(cli(paths.repo, env, 'runner', 'list', '--json').stdout).runners,
    result: gateResult };
}
