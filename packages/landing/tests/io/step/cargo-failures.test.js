/** @pullboard-test-input packages/landing/src/io/step/failures.js */
/** @pullboard-test-input packages/gate/src/logic/junit.js */
/** landingFailures names failing Rust tests from cargo test output when landing.cargoFailures is on [C7,#10385]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingFailures } from '../../../src/io/step/failures.js';

const CARGO = `   Compiling demo v0.1.0 (/work/demo)
     Running unittests src/lib.rs (target/debug/deps/demo-abc123)

running 3 tests
test math::adds ... ok
test math::breaks ... FAILED
test math::later ... ignored

failures:

---- math::breaks stdout ----

thread 'math::breaks' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 1
 right: 2

failures:
    math::breaks

test result: FAILED. 1 passed; 1 failed; 1 ignored
`;

const TAP = `TAP version 13
# Subtest: node case
not ok 1 - node case
  ---
  error: 1 !== 0
  location: /repo/test/real.test.js:5
  ...
`;

test('landing.cargo-failures.one-row-per-failing-test-with-its-panic-line: clause 1: with the setting on, one row per failing cargo test carries its name and panic line [C7,#10385]', () => {
  const rows = landingFailures(CARGO, '/repo', { cargoFailures: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'math::breaks');
  assert.equal(rows[0].file, 'src/lib.rs');
  assert.match(rows[0].assertion, /panicked at src\/lib\.rs:12:9/u);
});

test('landing.cargo-failures.setting-off-rows-are-todays: clause 2: with the setting off or absent the rows are exactly today’s [C7,#10385]', () => {
  assert.deepEqual(landingFailures(CARGO, '/repo', { cargoFailures: false }), landingFailures(CARGO, '/repo'));
  assert.deepEqual(landingFailures(CARGO, '/repo'), []);
  assert.deepEqual(landingFailures(CARGO, '/repo', { cargoFailures: 'yes' }), []);
});

test('landing.cargo-failures.node-tap-unchanged-and-junit-deduped: clause 3: Node TAP output is unchanged with the setting on, and a JUnit row of the same test name is not repeated [C7,#10385]', () => {
  assert.deepEqual(landingFailures(TAP, '/repo', { cargoFailures: true }), landingFailures(TAP, '/repo'));
  const xml = '<testsuites><testsuite name="s"><testcase name="math::breaks" classname="demo" file="src/lib.rs"><failure message="m">boom</failure></testcase></testsuite></testsuites>';
  const rows = landingFailures(CARGO, '/repo', { cargoFailures: true, junitFailures: true, junitXml: xml });
  assert.deepEqual(rows.map(row => row.name), ['math::breaks']);
  assert.equal(rows[0].assertion, 'm\nboom', 'the JUnit row stands, the cargo row is dropped');
});
