/** @pullboard-test-input source-tree */
/**
 * A red gate shows what it said, and submit runs the frozen item check and affected test only [C7,V4,V10,V16].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../../../tests/fixtures/submit/gate.js';
import { coordinatorLocal } from '../local.js';
import { runLocal } from '../local.js';
import { submitWithEnv } from '../local.js';
import { privateRepo } from '../../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../../tests/fixtures/submit/gate.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../../tests/fixtures/submit/gate.js';

/** A failed project command keeps its first diagnostic even when later output is unstructured. */
test('cli.journeys-submit-gate-selection-frozen.a-red-gate-on-submit-shows: a red gate on submit shows what the gate said [C7,V10]', async (t) => {
  for (const stream of ['log', 'error']) {
    let box = privateRepo(t);
    const first = stream === 'log' ? 'G1: merge main to get the missing row' : 'G1 error: commit cites it, but it was never committed to the spec';
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node test/gate-diagnostic.mjs', spec: 'SPEC.md', verify: 'any', lease: '2h' }));
    put(box.root, 'test/gate-diagnostic.mjs', [
      "import { existsSync } from 'node:fs';",
      "if (existsSync('src/RED')) {",
      `  console.${stream}(${JSON.stringify(first)});`,
      `  for (let n = 0; n < 80; n++) console.${stream}('detail ' + n + ': ' + 'x'.repeat(100));`,
      '  process.exit(1);',
      '}',
    ].join('\n'));
    commitAll(box);
    box = builderRepo(box);
    const added = await coordinatorLocal(box, 'add', 'build', 'Show the gate diagnostic');
    assert.equal(added.code, 0, added.err);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/RED', 'red\n');
    commitAll(box, 'feat(core): exercise gate output [G1]');
    const submitted = await submitWithEnv(t, box, (...args) => runLocal(box, ...args));
    assert.notEqual(submitted.code, 0);
    // The settled answer's last line is the gate job's own receipt; the lines before it are the refusal's text.
    const refusal = { message: submitted.err.split('\n').slice(0, -1).join('\n') };
    assert.ok(refusal.message.includes(first), `the first diagnostic must survive the bounded refusal: ${JSON.stringify(refusal)}`);
    assert.match(refusal.message, /\d+ nonempty output lines omitted/u);
    assert.ok(refusal.message.length < 5000, 'a refusal must remain bounded');
    // The pulled gate keeps the complete output as the runner's proof.log; its receipt names that log and the bytes it holds.
    const proof = submitted.receipt.gateJob.gate.phases.find(phase => phase.role === 'proof');
    assert.equal(proof.kept, 'proof.log', 'the complete gate output remains available in its log');
    assert.ok(proof.bytes > 8000, 'the kept log holds all eighty detail lines');
    assert.equal(JSON.parse((await runLocal(box, 'show', '1', '--json')).out).item_status, 'claimed');
  }
});
