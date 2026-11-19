/** @pullboard-world-pin: scans the tracked package test files for the CLI app's resources fixture paths and reads the package home and the app doors, to prove the stand-ins' home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app paths in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-resources-fixture.test.js';
const HOME = 'packages/gate/tests/fixtures/admission';
const NAMES = ['oldSchema', 'staleIdentity', 'expireHeartbeat', 'machineSettings', 'cpuCheckRepo', 'MODULE', 'POOL_MODULE_WORKER', 'PERL_FORK', 'PRE_RUNNER_MODULE', 'SANDBOX_EXEC', 'TEST_RUNNER', 'acquired', 'delay', 'event', 'fixture', 'insertExpiredHolder', 'memoryWorker', 'poolWorker', 'privateList', 'privateTake', 'release', 'requeuedRemoteRun', 'setQueueOrder', 'waitForMarker', 'waitForProcessState', 'waitUntil', 'worker', 'writeMemoryReading'];
const HOME_FILES = ['cpu', 'lease', 'pool', 'settings', 'runners'];

/** Tracked package test files that name a CLI app resources fixture (a package test importing the app kit). */
function importersOfAppFixtures() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/resources/(cpu|lease|pool|settings)\\.js', '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF && /\/tests\//u.test(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

/** The text of every home file. */
function homeSources() {
  return HOME_FILES.map(name => ({ name, text: readFileSync(`${ROOT}${HOME}/${name}.js`, 'utf8') }));
}

test('doctrine.kit-resources-fixture.clause-1-no-package-test-file-imports: clause 1: no tracked package test file imports the CLI resources fixtures lease, pool, settings, cpu or runners [C7]', () => {
  assert.deepEqual(importersOfAppFixtures(), []);
});

test('doctrine.kit-resources-fixture.clause-2-package-home: clause 2: the package-side home exports every name the one importer used and no home file names an apps/ path [C7]', () => {
  const exported = homeSources().map(({ text }) => text).join('\n');
  for (const name of NAMES) assert.match(exported, new RegExp(`\\b${name}\\b`, 'u'), name);
  const pool = homeSources().find(({ name }) => name === 'pool').text;
  const names = /export \{([^}]*)\}/u.exec(pool)[1].split(',').map(name => name.trim());
  for (const name of ['MODULE', 'POOL_MODULE_WORKER', 'PERL_FORK', 'PRE_RUNNER_MODULE', 'SANDBOX_EXEC', 'TEST_RUNNER', 'acquired', 'delay', 'event', 'fixture', 'insertExpiredHolder', 'memoryWorker', 'poolWorker', 'privateList', 'privateTake', 'release', 'requeuedRemoteRun', 'setQueueOrder', 'waitForMarker', 'waitForProcessState', 'waitUntil', 'worker', 'writeMemoryReading']) assert.ok(names.includes(name), name);
  for (const { name, text } of homeSources()) assert.doesNotMatch(text, /apps\//u, `${name}.js names an apps/ path`);
});

test('doctrine.kit-resources-fixture.clause-3-cli-doors: clause 3: each old CLI path is an export * door [C7]', () => {
  for (const [path, name] of [['apps/cli/tests/fixtures/resources/cpu.js', 'cpu'], ['apps/cli/tests/fixtures/resources/lease.js', 'lease'], ['apps/cli/tests/fixtures/resources/pool.js', 'pool'], ['apps/cli/tests/fixtures/resources/settings.js', 'settings'], ['apps/cli/tests/fixtures/runners.js', 'runners']]) {
    assert.equal(existsSync(`${ROOT}${path}`), true, path);
    const lines = readFileSync(`${ROOT}${path}`, 'utf8').split('\n').filter(line => line.trim() && !/^\s*(\/\*\*|\*)/u.test(line));
    const doors = lines.filter(line => /^export \*/u.test(line));
    assert.equal(doors.length, 1, `${path} has one export * door`);
    assert.match(doors[0], new RegExp(`^export \\* from '[./]*packages/gate/tests/fixtures/admission/${name}\\.js';$`, 'u'));
    assert.deepEqual(lines.filter(line => !/^export \*/u.test(line)).map(line => line.replace(/'[./]*packages/u, "'packages")), [`import * as home from 'packages/gate/tests/fixtures/admission/${name}.js';`, 'export const ADMISSION_FIXTURE_NAMES = Object.keys(home);'], 'the door lists its names and nothing else');
  }
});
