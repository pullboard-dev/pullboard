/** The generated AGENTS.md and help verify teach the full reject form with its reason codes [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAgentsBlock } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';

const REASONS = ['TEST_FAILURE', 'BEHAVIOR_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'STALE_HEAD', 'OTHER'];

test('clause 1: the generated AGENTS.md reject line carries --reason, --clause and --note [C7]', () => {
  assert.ok(
    renderAgentsBlock().includes('pullboard verify <id> reject --reason <CODE> --clause "<clause>" --note "..."'),
  );
});

test('clause 2: help verify lists every reject reason code [C7]', async () => {
  const { stdout } = await captureCommandInProcess(main, ['help', 'verify']);
  for (const code of REASONS) assert.ok(stdout.includes(code), `help verify names ${code}`);
});
