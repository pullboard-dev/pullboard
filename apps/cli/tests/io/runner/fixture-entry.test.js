/** @pullboard-test-input source-cell apps/cli */
/** The local-start and local-stop runner fixtures take the CLI entry path from the caller and build none themselves [C7,#8203]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviveFixtureLocalRunner } from '../../fixtures/runner/local-start.js';
import { startFixtureLocalRunner } from '../../fixtures/runner/local-start.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/runner');

test('cli.io-runner-fixture-entry.neither-runner-fixture-builds-a-cli-entry: clause 1: neither runner fixture builds a CLI entry path of its own [C7]', () => {
  for (const file of ['local-start.js', 'local-stop.js']) {
    const source = readFileSync(join(FIXTURES, file), 'utf8');
    assert.doesNotMatch(source, /pullboard\.js/u, `${file} names no CLI entry file`);
    assert.doesNotMatch(source, /\bBIN\b/u, `${file} keeps no entry constant`);
  }
});

test('cli.io-runner-fixture-entry.starting-a-fixture-local-runner-without-an: clause 1: starting a fixture local runner without an entry refuses before it spawns anything [C7]', () => {
  assert.throws(() => startFixtureLocalRunner({}, '/nonexistent'), /needs \{ entry \}/u);
  assert.throws(() => startFixtureLocalRunner({}, '/nonexistent', { entry: '' }), /needs \{ entry \}/u);
});

test('cli.io-runner-fixture-entry.the-start-fixture-takes-the-entry-as: clause 1: the start fixture takes the entry as the option the caller passes [C7]', () => {
  const source = readFileSync(join(FIXTURES, 'local-start.js'), 'utf8');
  assert.match(source, /function startFixtureLocalRunner\(env, root, \{ entry \} = \{\}\)/u);
  assert.match(source, /function reviveFixtureLocalRunner\(cwd, env, \{ entry = CLI_ENTRY \} = \{\}\)/u);
  assert.equal(typeof reviveFixtureLocalRunner, 'function');
});
