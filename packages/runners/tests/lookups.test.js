/** @pullboard-test-input packages/resources/src/io/admission/memory.js packages/gate/tests/fixtures/diagnostics.js packages/sentinels/src/io/cpu.js */
/** Nonblocking process diagnostics preserve their target and safe failure information [C7,N26]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readMachineMemory } from '../../resources/index.js';
import { memoryVerdict } from '../../resources/index.js';
import { toolSourcePath } from '../index.js';
import { cleanupFailureReport } from '../../gate/tests/fixtures/diagnostics.js';

/** Inject only the documented OS-tool boundary; all production parsing and failure rendering still run. */
async function memoryProbe(fail = false) {
  const calls = [];
  const reading = await readMachineMemory({ platform: 'darwin', processes: true,
    /** Return deterministic memory/process readings and capture the real cwd-probe argv. */
    async run(command, args) {
      if (command.endsWith('/sysctl')) return '1 20 17179869184';
      if (command.endsWith('/ps')) return '43210 4096 fixture-node';
      assert.equal(command, '/usr/sbin/lsof'); calls.push(args);
      if (fail) throw Object.assign(new Error('private cwd lookup timed out'), { code: 'ETIMEDOUT' });
      return 'n/private/fixture-cwd';
    },
  });
  return { reading, calls };
}

test('runners.lookups.memory-process-directories-use-nonblocking-lsof: memory process directories use nonblocking lsof without losing successful cwd data [C7]', async () => {
  const { reading, calls } = await memoryProbe();
  assert.equal(reading.checked, true);
  assert.ok(calls.length > 0 && calls.every(args => args.includes('-b')));
  assert.equal(reading.processes[0].cwd, '/private/fixture-cwd');
});

test('runners.lookups.a-failed-process-directory-lookup-names: a failed process-directory lookup names its pid and failure while memory admission remains available [C7]', async () => {
  const { reading } = await memoryProbe(true);
  assert.equal(reading.checked, true);
  const result = memoryVerdict(reading, reading.totalBytes);
  assert.equal(result.held, true);
  assert.match(result.line, /43210/u);
  assert.match(result.line, /directory.*lsof.*ETIMEDOUT/iu);
});

/** Quote only a private fixture path as one literal shell word. */
function shellWord(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

test('runners.lookups.cleanup-ownership-probes-request-nonblocking-lsof: cleanup ownership probes request nonblocking lsof and retain scoped holder evidence [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-lsof-flags-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'args.txt'), path = join(root, 'lsof');
  const script = '#!/bin/sh\n' + 'printf "%s\\n" "$@" > ' + shellWord(output)
    + '\nprintf "%s\\n" ' + shellWord('p99999\ncUNRELATED_PRIVATE_PROCESS\nn/private/unrelated/PRIVATE_OTHER_PATH\np43210\ncfixture-node\nn' + root + '/held.txt\nn/private/unrelated/PRIVATE_OTHER_PATH') + '\n';
  writeFileSync(path, script);
  chmodSync(path, 0o700);
  const old = process.env.PATH; process.env.PATH = root;
  let report;
  try { report = cleanupFailureReport(Object.assign(new Error('private cleanup failed'), { code: 'ENOTEMPTY', path: root }), root); }
  finally { process.env.PATH = old; }
  assert.ok(readFileSync(output, 'utf8').split('\n').includes('-b'));
  assert.match(report, /pid=43210 command=fixture-node/u);
  assert.ok(report.includes(root + '/held.txt'));
  assert.doesNotMatch(report, /PRIVATE_OTHER_PATH|UNRELATED_PRIVATE_PROCESS/u, 'unrelated descriptor names and processes never enter fixture diagnostics');
});

test('runners.lookups.literal-process-directory-and-cleanup-helper: literal process-directory and cleanup helper probes all retain the nonblocking flag [C7]', () => {
  const sources = [['packages/resources/src/io/admission/memory.js', readFileSync(toolSourcePath(join(import.meta.dirname, '../../..'), 'packages/resources/src/io/admission/memory.js'), 'utf8')]];
  for (const path of ['packages/gate/tests/fixtures/diagnostics.js', 'packages/sentinels/src/io/cpu.js']) sources.push(['./' + path, readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')]);
  let calls = 0;
  for (const [path, source] of sources) {
    const probes = source.matchAll(/(?:spawnSync|run|runFixtureProcessTool)\(\s*(['"])(?:\/usr\/(?:sbin|bin)\/)?lsof\1\s*,\s*\[([^\]]*)\]/gu);
    for (const probe of probes) { calls++; assert.match(probe[2], /['"]-b['"]/u, path + ' uses nonblocking lsof'); }
  }
  assert.ok(calls >= 3, 'the census covers the memory, fixture cleanup and cpu sentinel probes');
});
