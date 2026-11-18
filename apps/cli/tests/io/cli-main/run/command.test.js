/** @pullboard-test-input apps/cli/src/io/cli-main/run/command.js */
/** --route prints one stderr line naming --level, and never touches the stdout document [C7,#10966]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../../../../src/io/cli-main/run/command.js';

/** Run one command against a recording io: what it said, what its document held, and what went to stderr. */
async function run(argv) {
  const seen = { say: [], result: [], err: [] };
  const io = { jsonMode() {}, say: line => seen.say.push(line), result: document => seen.result.push(document), err: line => seen.err.push(line) };
  seen.code = await runCommand(argv, io);
  return seen;
}

test('cli.io-cli-main-run-command.route-prints-one-deprecation-line-naming-level: clause 1: --route prints one stderr line naming --level, and --level prints none [C7,#10966]', async () => {
  for (const argv of [['version', '--route', 'mid'], ['version', '--route=mid']]) {
    const seen = await run(argv);
    assert.equal(seen.code, 0);
    assert.equal(seen.err.length, 1, 'one line');
    assert.match(seen.err[0], /--level/);
  }
  const level = await run(['version', '--level', 'mid']);
  assert.equal(level.code, 0);
  assert.deepEqual(level.err, []);
});

test('cli.io-cli-main-run-command.the-deprecation-line-stays-out-of-json-output: clause 2: with --json the stdout document and said lines are the same with --route as without it [C7,#10966]', async () => {
  const plain = await run(['version', '--json']);
  const routed = await run(['version', '--json', '--route', 'mid']);
  assert.deepEqual(routed.result, plain.result);
  assert.deepEqual(routed.say, plain.say);
  assert.equal(routed.err.length, 1, 'the line still goes to stderr, never to stdout');
});
