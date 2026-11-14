/**
 * The SessionStart hook finishes inside its 2 s timeout on a board of thousands of items: its worker reads only the
 * hand-off records of items still in play and never runs the spec blame behind the person's needs [I6].
 */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 2: the resume card the SessionStart worker prints starts no spec blame and only a bounded number of git processes [I6]', async () => {
  const box = e2e.project('true');
  const trace = join(box.dir, 'trace.log');
  // A row the baseline never saw is agent-approved, the case that made resume blame the whole spec file.
  appendFileSync(join(box.web, 'SPEC.md'), '- G3 [approved, must] The footer renders. | gate: web test\n');
  const result = await runCliInProcess(['resume'], { cwd: box.web, env: { ...process.env, ...box.env, GIT_TRACE: trace } });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^resume: /mu, 'the resume card is still the hook context');
  const traced = readFileSync(trace, 'utf8');
  const commands = traced.split('\n').filter(line => /trace: (?:built-in|exec): git(?: |$)/u.test(line));
  assert.ok(commands.length > 0, 'the trace saw the worker run git');
  assert.deepEqual(commands.filter(line => /git.* blame /u.test(line)), [], 'no spec blame runs for a seat');
  // The worker measured 9 git processes on a seat of a 7,800-item board; the bound leaves room for a probe or two.
  assert.ok(commands.length <= 20, `git ran ${commands.length} times in the hook worker`);
});
