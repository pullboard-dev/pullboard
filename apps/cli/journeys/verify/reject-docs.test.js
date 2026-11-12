/** The generated AGENTS.md and help verify show the whole reject form (UX F7, #6564). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAgentsBlock } from '../../../../packages/config/src/io/templates.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

test('clause 1: the generated AGENTS.md reject line reads reject --reason <CODE> --clause "<clause>" --note "..." [F7]', () => {
  assert.ok(renderAgentsBlock().includes('`pullboard verify <id> reject --reason <CODE> --clause "<clause>" --note "..."`'));
});

test('clause 2: help verify lists the reject reason codes [F7]', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const help = await box.runIn(box.repo, 'help', 'verify');
  assert.equal(help.code, 0, help.err + help.out);
  for (const code of ['TEST_FAILURE', 'BEHAVIOR_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'STALE_HEAD', 'OTHER']) {
    assert.ok(help.out.includes(code), `help verify names ${code}`);
  }
});
