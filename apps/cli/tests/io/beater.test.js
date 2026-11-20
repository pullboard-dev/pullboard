/** The claim beater beats a URL-joined seat through the board host's heartbeat move [P7,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBeater } from '../../src/io/beater.js';

test('cli.io-beater.remote-binding-beats-until-refused: runBeater with a remote binding beats through an injected sender every injected everyMs and stops after the first refusal [P7,B3,C7]', async () => {
  const remote = { url: 'http://127.0.0.1:1/api/v1/boards/b1', token: 'k', agent: 'core-1' };
  const answers = [true, true, false];
  const sent = [];
  const waits = [];
  const result = await runBeater(
    { cwd: process.cwd(), seat: 'core-1', board: '/nowhere/board.sqlite', lock: '/nowhere/beaters/core-1', agent: { pid: 1, start: null }, everyMs: 7, remote },
    { alive: () => true, send: async (binding) => { sent.push(binding); return answers.shift(); }, wait: async (ms) => { waits.push(ms); } },
  );
  assert.equal(sent.length, 3, 'it beat until the third answer refused, then no more');
  assert.ok(sent.every((binding) => binding === remote), 'every beat carried the remote binding');
  assert.deepEqual(waits, [7, 7, 7], 'each pause was the injected everyMs');
  assert.equal(result.beats, 3);
});
