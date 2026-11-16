/** One seat-loop source generates the AGENTS.md block, and the loop stays short [C7]. */
/** @pullboard-world-pin: clause 1 compares the generated loop with this repository's approved AGENTS.md, word for word. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { test } from 'node:test';
import {
  AGENTS_END,
  AGENTS_START,
  SEAT_LOOP,
  SEAT_LOOP_WORD_BUDGET,
  renderAgentsBlock,
} from '../../../../packages/config/index.js';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

test('clause 1: init writes the AGENTS.md seat-loop block generated from one shared source [C7]', async t => {
  const inputs = privateFixtureFiles('pullboard-seat-loop-');
  const root = inputs.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.com'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'base']]) {
    assert.equal(runFixtureChild('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  }
  const result = await runCliInProcess(['init'], { cwd: root, env: { ...process.env, CI: '1' } });
  const written = readFileSync(`${root}/AGENTS.md`, 'utf8');
  const block = written.slice(written.indexOf(AGENTS_START), written.indexOf(AGENTS_END) + AGENTS_END.length);
  assert.ok(block.includes(SEAT_LOOP), `the written block holds the shared loop (init exit ${result.status})`);
  assert.equal(block.trimEnd(), renderAgentsBlock().trimEnd(), 'the written block is the generated block');
  const repo = readFileSync(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
  assert.ok(repo.includes(SEAT_LOOP), 'this repo\'s approved AGENTS.md carries the same loop word for word');
});

test('clause 2: the seat loop stays under the set word budget [C7]', () => {
  const words = SEAT_LOOP.split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= SEAT_LOOP_WORD_BUDGET, `${words} words, budget ${SEAT_LOOP_WORD_BUDGET}`);
  assert.ok(words > SEAT_LOOP_WORD_BUDGET / 2, 'the budget is tight to the real loop, not slack');
});
