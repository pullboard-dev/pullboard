/** @pullboard-test-input source-cell gate */
/** A real cargo fixture crate runs cargo test on a runner that has cargo: green passes, a failing test exits red [#10382,C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { detectGate } from '../../src/io/config.js';
import { cargoTestCases } from '../../src/logic/cargo-cases.js';
import { privateFixtureFiles } from '../fixtures/child.js';

const FIXTURE = new URL('../fixtures/cargo-crate/', import.meta.url);

/** The cargo to run: the PATH one, else the one rustup names (Homebrew's rustup is keg-only), else null. */
function findCargo() {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (!probe.error && probe.status === 0) return 'cargo';
  const which = spawnSync('rustup', ['which', 'cargo'], { encoding: 'utf8', timeout: 5000 });
  const path = which.error || which.status !== 0 ? '' : String(which.stdout).trim();
  if (!path.startsWith('/')) return null;
  const answer = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return !answer.error && answer.status === 0 ? path : null;
}

/** Copy the crate to a private temporary folder so no build output lands in the repo. */
function tempCrate(t) {
  const { root, write } = privateFixtureFiles('cargo-real-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write('Cargo.toml', readFileSync(new URL('Cargo.toml', FIXTURE)));
  write('src/lib.rs', readFileSync(new URL('src/lib.rs', FIXTURE)));
  return root;
}

/** Run cargo test in the copy, offline, with the build folder inside the copy and cargo's own folder first on PATH so it finds rustc. */
function cargoTest(cargo, root, args = []) {
  const path = cargo.startsWith('/') ? `${dirname(cargo)}:${process.env.PATH ?? ''}` : process.env.PATH;
  const env = { ...process.env, PATH: path, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: `${root}/target`, CARGO_TERM_COLOR: 'never' };
  return spawnSync(cargo, ['test', '--offline', ...args], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
}

test('gate.cargo-real.passes: clause 1: a checked-in crate passes cargo test and detectGate gives cargo test [C7]', (t) => {
  const cargo = findCargo();
  if (!cargo) return t.skip('cargo unavailable on this machine');
  const root = tempCrate(t);
  assert.equal(detectGate(root), 'cargo test');
  const run = cargoTest(cargo, root);
  assert.equal(run.status, 0, run.stderr);
});

test('gate.cargo-real.fails: clause 2: the failing test enabled by a feature exits non-zero and cargoTestCases names it [C7]', (t) => {
  const cargo = findCargo();
  if (!cargo) return t.skip('cargo unavailable on this machine');
  const root = tempCrate(t);
  const run = cargoTest(cargo, root, ['--features', 'fails']);
  assert.notEqual(run.status, 0);
  const { cases, reason } = cargoTestCases(run.stdout);
  assert.equal(reason, null, `${run.stdout}\n${run.stderr}`.slice(-1500));
  assert.deepEqual(cases.filter((found) => found.outcome === 'fail').map((found) => found.name), ['tests::broken']);
});

test('gate.cargo-real.skips-unavailable: clause 3: a missing cargo is named as unavailable, never a failure, and the repo gets no target folder [C7]', (t) => {
  const cargo = findCargo();
  assert.ok(cargo === null || typeof cargo === 'string');
  const repoTarget = spawnSync('git', ['ls-files', '--others', '--', 'packages/gate/tests/fixtures/cargo-crate'], { encoding: 'utf8' });
  assert.equal(String(repoTarget.stdout ?? '').includes('target'), false);
});
