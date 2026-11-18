/** The enqueue script starts the runner agent at the launching shell's priority, whatever the login shell's job control does [C7,#10985]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { getPriority } from 'node:os';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { enqueueScript } from '../../../src/io/pull/scripts.js';
import { pullWord } from '../../../src/io/pull/scripts.js';

/** zsh renices background jobs by 5 (BG_NICE, on by default), as the runner account's login shell does over ssh; sh stands in where zsh is absent. */
function loginShell() {
  return spawnSync('/bin/sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim() || '/bin/sh';
}

/** The stand-in agent's recorded nice, read once the background start has written it (at most 20 s), or what it printed instead. */
function recorded(root, file) {
  const wait = spawnSync('/bin/sh', ['-c', 'i=0; while [ ! -f "$1" ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done', 'wait', file]);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : `never written (wait ${wait.status}); agent stderr: ${existsSync(join(root, 'agent.err')) ? readFileSync(join(root, 'agent.err'), 'utf8') : 'none'}`;
}

test('runners.pull-scripts.agent-start-keeps-the-launcher-nice: clause 1: an enqueue script run by zsh starts the agent at the launching shell\'s nice, not +10 [C7,#10985]', () => {
  const { root } = privateFixtureFiles('enqueue-nice-');
  const seen = join(root, 'agent-nice');
  // The stand-in agent has runnerAgentStartCommand's background shape (sh -c <script> ... &) and records its own nice with node.
  // No nohup: macOS nohup refuses a job that has no console session ("can't detach from console"), as a pulled runner job has none.
  const record = `const { writeFileSync, renameSync } = require('node:fs'); writeFileSync(${JSON.stringify(`${seen}.tmp`)}, String(require('node:os').getPriority())); renameSync(${JSON.stringify(`${seen}.tmp`)}, ${JSON.stringify(seen)});`;
  const agent = `sh -c ${pullWord(`${pullWord(process.execPath)} -e ${pullWord(record)}`)} < /dev/null > /dev/null 2> ${pullWord(join(root, 'agent.err'))} &`;
  const script = enqueueScript({ root: join(root, 'runner') }, { id: 'nice-1', frameBytes: 2, command: 'true', agent });
  const shell = loginShell();
  try {
    const run = spawnSync(shell, shell.endsWith('zsh') ? ['-f', '-c', script] : ['-c', script], { input: '{"id":"nice-1"}\nok', encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /queued nice-1/u);
    const nice = recorded(root, seen);
    assert.equal(Number(nice), getPriority(), `agent nice ${nice} vs launcher ${getPriority()} under ${shell}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
