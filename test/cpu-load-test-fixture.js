/** Exercise CPU-test placement with a real committed repo, SSH worker, and private machine leases [C7]. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { awaitNestedRun } from '../src/test-file-pool.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';

const SOURCE = resolve(import.meta.dirname, '..');
let fixtureSequence = 0;

/** Build an ordinary CLI fixture whose declared test reports its actual checkout and live holder. */
export function cpuLoadFixture(e2e, { declaration = '{ cpuLoad: true }', binding = 'test', subtest = null, commonjs = false, dynamicImport = false, importBinding = null, moduleSpecifier = 'node:test', importedOptions = false, registrationHelper = false, lifecycleHelper = false } = {}) {
  const fixture = ++fixtureSequence;
  const started = performance.now();
  /** Expose only bounded phase metadata so a timed-out diagnostic retains the last reached setup step. */
  const stage = phase => console.error('CPU_LOAD_STAGE ' + JSON.stringify({ fixture, phase, elapsedMs: Math.round(performance.now() - started) }));
  stage('project-start');
  const probeFile = `cpu-probe.test.${commonjs ? 'cjs' : 'js'}`;
  const box = e2e.project(`node bin/run-tests.js test/${probeFile}`, undefined, { withWorktree: false });
  stage('project-ready');
  const bin = join(box.dir, 'ssh-bin');
  const remoteHome = join(box.dir, 'runner-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const requests = join(box.dir, 'ssh-requests.jsonl');
  for (const path of [bin, join(box.dir, 'worker'), remoteMachineHome, join(box.repo, 'test')]) mkdirSync(path, { recursive: true });
  cpSync(join(SOURCE, 'src'), join(box.repo, 'src'), { recursive: true });
  cpSync(join(SOURCE, 'bin'), join(box.repo, 'bin'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ name: 'pullboard', version: '1.0.0', type: 'module' }) + '\n');
  if (registrationHelper) {
    writeFileSync(join(box.repo, 'test', 'registrations.js'), registrationHelper === 'wrapper'
      ? "import { test, after } from 'node:test'; export { after }; export const launch = (...args) => test(...args);\n"
      : "export { test as launch, after } from 'node:test';\n");
    writeFileSync(join(box.repo, 'test', 'registration-barrel.js'), "export { launch, after } from './registrations.js';\n");
  }
  if (lifecycleHelper) writeFileSync(join(box.repo, 'test', 'lifecycle.js'), "import { after } from 'node:test'; after(() => {});\n// Text is not CPU load: { cpuLoad: true }\n");
  if (importedOptions) writeFileSync(join(box.repo, 'test', 'options.js'), 'export const options = { cpuLoad: true };\n');
  writeFileSync(join(box.repo, 'test', probeFile), `${commonjs
    ? `const { test: ${binding}, after: finish } = require('node:test');\nconst { DatabaseSync } = require('node:sqlite');`
    : dynamicImport
      ? `const { default: ${binding}, after: finish } = await import('node:test');\nimport { DatabaseSync } from 'node:sqlite';`
      : `import { ${importBinding ?? `test${binding === 'test' ? '' : ` as ${binding}`}`}, after as finish } from '${moduleSpecifier}';\nimport { DatabaseSync } from 'node:sqlite';`}
${importedOptions ? "import { options } from './options.js';" : ''}
${lifecycleHelper ? "import './lifecycle.js';" : ''}
// Example text is not a declaration: { cpuLoad: true }
const example = '{ cpuLoad: true }';
finish(() => {});
${subtest ? `${binding}('parent', async t => { t.after(() => {}); await ${subtest}` : binding}('declared load stand-in', ${declaration}, () => {
  const db = new DatabaseSync(process.env.PULLBOARD_GATE_SLOT_POOL, { readOnly: true });
  const row = db.prepare('SELECT * FROM holder WHERE token=?').get(process.env.PULLBOARD_GATE_SLOT_TOKEN);
  db.close();
  console.log('CPU_LOAD_EXECUTOR ' + JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,
    gatePool: process.env.PULLBOARD_GATE_SLOT_POOL, liveLease: Boolean(row), runnerExecution: row?.runner_execution === 1, browserLease: row?.browser === 1 }));
});
${subtest ? '});' : ''}
`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: commit declared CPU placement probe');
  stage('source-committed');
  installSshStandIn({ bin, worker: join(box.dir, 'worker'), home: remoteHome, machineHome: remoteMachineHome, requests });
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  /** Use the ordinary fixture CLI to configure its own genuine runner registration and policy. */
  function command(...args) {
    const result = box.run(box.repo, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  }
  // CommonJS conservatively needs browser admission; this private worker supplies a genuine browser slot.
  command('runner', 'add', HOST, '--slots', '1', '--browser', commonjs ? '1' : '0');
  command('settings', 'gate.runnersFirst', 'off');
  command('settings', 'gateSlots', '1');
  stage('runner-registered');
  const cli = join(SOURCE, 'bin', 'pullboard.js');
  return {
    ...box, env, requests, remoteHome, remoteMachineHome, command,
    /** Count real completed SSH requests without treating a configured host as execution proof. */
    requestsMade() { return existsSync(requests) ? readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; },
    /** Commit a harmless source change so the next public gate executes instead of reusing a green tree. */
    commitProbeChange() {
      const probe = join(box.repo, 'test', probeFile);
      writeFileSync(probe, readFileSync(probe, 'utf8') + '\n// A new fixture revision exercises ordinary gate execution again.\n');
      box.git(box.repo, 'add', `test/${probeFile}`);
      box.git(box.repo, 'commit', '-q', '-m', 'test: advance the CPU placement fixture source');
    },
    /** Run the public landing gate under its ordinary lease and wait on its original child promise. */
    async runGate() {
      stage('gate-start');
      const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [cli, 'gate', '--landing', '--json'],
        { cwd: box.repo, env, encoding: 'utf8' }));
      stage('gate-returned');
      const log = readFileSync(join(box.repo, '.git', 'pullboard-gate.log'), 'utf8');
      if (result.status !== 0) console.error('CPU placement gate output:', result.stdout, '\nGate log:', log);
      const match = /^# CPU_LOAD_EXECUTOR (.+)$/mu.exec(log);
      return { result, log, executor: match ? JSON.parse(match[1]) : null };
    },
  };
}
