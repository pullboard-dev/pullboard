/** Private real-CLI/Git fixtures retain source and receipt guards for remote outcome tests [V4,B3,H16]. */
import '../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { HOST } from '../runner/ssh.js';
import { installSshStandIn } from '../runner/ssh.js';
import { TIMING_RUN_ID_ENV } from '../../../../../packages/gate/index.js';
import { runFixtureChild } from '../child.js';
import { runFixtureChildAsync } from '../child.js';
import { runCliInProcess } from '../process.js';
import { runFixtureGit } from '../child.js';
import {
  createFixtureWorktree,
  fileFixtureItem,
  fixtureMachineSettings,
} from '../testkit.js';

const BIN = join(import.meta.dirname, '../../../pullboard.js');

/** Write one ordinary committed fixture input. */
function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Run the actual command with isolated identity and machine settings. */
function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, ...(args.includes('--json') ? [] : ['--json'])], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** The same command answered by the production dispatcher in this process; setup calls skip a node start-up each. */
async function local(box, root, ...args) {
  const result = await runCliInProcess([...args, ...(args.includes('--json') ? [] : ['--json'])], { cwd: root, env: box.env });
  return { ...result, status: result.status };
}

/** The real executable, launched without blocking, so independent cases overlap their gates. */
function cliAsync(box, root, ...args) {
  return runFixtureChildAsync(process.execPath, [BIN, ...args, ...(args.includes('--json') ? [] : ['--json'])], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit fixture changes normally, retaining its real Git history. */
function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): inherited failure fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** Produce a real assertion failure whose name and error details are independently variable. */
function source(name = 'shared failure [G1]', expected = 2) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest(${JSON.stringify(name)}, () => assert.equal(1, ${expected}));\n`;
}

/** Build and claim one private board whose accepted main already has a named red test. */
async function fixture(t, { candidate = source(), check = 'test -f change.txt', gateSuffix = '', mainRed = true, beforeMain } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-main-red-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, {
    PATH: [join(directory, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Main red fixture', GIT_AUTHOR_EMAIL: 'main-red@example.invalid',
    GIT_COMMITTER_NAME: 'Main red fixture', GIT_COMMITTER_EMAIL: 'main-red@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    CODEX_SESSION_ID: 'submit-main-red-fixture', PULLBOARD_MODEL: 'Fixture Model',
    // A fixture's infrastructure retry does not wait out the real 30 s back-off (#3365).
    PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline',
  });
  // These submits hold their gate in the submitting process, so the fixture pins controller dispatch [P7].
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  const box = { directory, root, env };
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  let result = await local(box, root, 'init');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js' + gateSuffix,
    affectedTests: 'node test/runner.js', lanes: { core: { owns: ['test/', 'change.txt'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The unrelated change works. | gate: test/inherited.test.js\n');
  put(root, 'test/inherited.test.js', source());
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  beforeMain?.(box);
  box.main = commit(box, root);
  box.item = (await fileFixtureItem(box, root, { lane: 'core', title: 'Unrelated change', criterion: 'The unrelated change works.',
    check, route: 'mid', diagnose: false, brief: 'Files: change.txt test/inherited.test.js\nChange: add change.txt\nTest: inherited failure accounting', args: ['--specs', 'G1'],
    run: (cwd, ...args) => local(box, cwd, ...args) })).item_id;
  result = await createFixtureWorktree(box, root, 'core', { route: 'mid', run: (cwd, ...args) => local(box, cwd, ...args) });
  assert.equal(result.code, 0, result.out + result.err);
  box.builder = JSON.parse(result.out).path;
  result = await local(box, box.builder, 'claim', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(box.builder, 'change.txt', 'Unrelated change.\n');
  put(box.builder, 'test/inherited.test.js', candidate);
  box.head = commit(box, box.builder);
  if (mainRed) box.rework = await fileMainRed(box);
  return box;
}

/** File a still-open repair with the exact failing test in its declared check. */
function fileMainRed(box) {
  return fileFixtureItem(box, box.root, { lane: 'core', title: 'Main red: inherited assertion needs repair', args: ['--specs', 'G1'],
    criterion: 'The inherited assertion passes on main.', check: 'node test/runner.js test/inherited.test.js',
    diagnose: false, brief: 'Files: test/inherited.test.js\nChange: repair the assertion\nTest: inherited assertion', run: (cwd, ...args) => local(box, cwd, ...args) }).then(item => item.item_id);
}

/** Read the canonical submitted receipt rather than trusting a successful shell exit alone. */
async function submittedProof(box) {
  const result = await local(box, box.root, 'log', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const row = JSON.parse(result.stdout).events.filter(event => event.event_kind === 'submit').at(-1);
  return row ? JSON.parse(row.event_detail) : null;
}

/** The production collector observes real Node events inside the worker's source tree. */
function beforeMain({ duplicate = false, phases = false, timing = true, corrupt = null } = {}) {
  return box => {
    const files = ['test/inherited.test.js', ...(duplicate ? ['test/second.test.js'] : []), ...(phases ? ['test/shared-pass.test.js'] : [])];
    const timingModule = new URL('../../../../../packages/gate/index.js', import.meta.url).href;
    const beginTiming = timing ? 'beginSuiteTiming(process.cwd(), process.argv.slice(2));' : '';
    if (duplicate) put(box.root, 'test/second.test.js', source());
    if (phases) {
      put(box.root, 'test/check-only.test.js', "import { describe, test } from 'node:test';\ntest('criterion only pass [G1]', () => {});\n");
      put(box.root, 'test/shared-pass.test.js', "import { describe, test } from 'node:test';\ntest('shared phase pass [G1]', () => {});\n");
      put(box.root, 'test/check-runner.js', `import { spawnSync } from 'node:child_process';
import { beginSuiteTiming } from ${JSON.stringify(timingModule)};
// The actual private controller observes its own clean source and wall duration.
${beginTiming}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=./test/outcome-reporter.js',
  'test/check-only.test.js', 'test/shared-pass.test.js'], { encoding: 'utf8', env: process.env });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? ''); process.exitCode = run.status ?? 1;
`);
    }
    const outcomesModule = new URL('../../../../../packages/gate/src/io/test/outcomes.js', import.meta.url).href;
    put(box.root, 'test/native-outcomes.js', `export { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(outcomesModule)};\n`);
    put(box.root, 'test/outcome-reporter.js', `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from './native-outcomes.js';
export default async function* report(events) {
  const collector = testOutcomeCollector(process.cwd());
  let count = null;
  async function* observe() {
    for await (const event of events) {
      collector.observe(event);
      if (event.type === 'test:summary') count = event.data.counts.tests;
      yield event;
    }
  }
  for await (const chunk of tap(observe())) yield chunk;
  const outcomes = formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));
  yield ${corrupt === 'malformed' ? "outcomes.replace('version', 'invalidVersion')" : 'outcomes'};
  ${corrupt === 'foreign' ? "yield formatTestOutcomes('00000000-0000-4000-8000-000000000000', collector.finish(count !== null, count));" : ''}
}
`);
    put(box.root, 'test/runner.js', `import { spawnSync } from 'node:child_process';
import { beginSuiteTiming } from ${JSON.stringify(timingModule)};
// Preserve genuine producer timing; no fabricated frame or completed-file claim.
${beginTiming}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=./test/outcome-reporter.js', ...${JSON.stringify(files)}],
  { encoding: 'utf8', env: process.env });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
process.exitCode = run.status ?? 1;
`);
  };
}

/** The existing stand-in launches the real worker locally; zero local slots prove the remote path was used. */
async function remote(box) {
  const bin = join(box.directory, 'remote-bin'), worker = join(box.directory, 'worker'), home = join(box.directory, 'worker-home');
  const machineHome = join(home, '.pullboard'), requests = join(box.directory, 'requests.jsonl');
  for (const path of [bin, worker, home, machineHome]) mkdirSync(path, { recursive: true });
  box.env.PATH = bin + ':' + box.env.PATH;
  installSshStandIn({ bin, worker, home, machineHome, requests });
  let result = await local(box, box.root, 'runner', 'add', HOST, '--slots', '2', '--browser', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    result = await local(box, box.root, 'settings', key, value);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return requests;
}

/** Read actual profile bytes through public response paths; do not manufacture failure identity. */
function readProfile(path) { return JSON.parse(readFileSync(path, 'utf8')); }


export { beforeMain, remote, readProfile, cli, cliAsync, local, fixture, submittedProof, put, source };
