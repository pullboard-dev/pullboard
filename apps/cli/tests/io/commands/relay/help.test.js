/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runCliInProcess } from '../../../fixtures/process.js';

test('cli.journeys-relay-setup.relay-help-lists-every-relay-command: relay help lists every relay command, with a whole example [H17]', async () => {
  const printed = await runCliInProcess(['relay', '--help'], { cwd: tmpdir() });
  assert.equal(printed.status, 0, printed.stderr);
  const [usage, rest] = printed.stdout.split('\nFlags:\n');
  for (const command of ['relay [status|on|off|pair|join <code>]', 'relay on --all', 'relay devices', 'relay revoke <device>',
    'relay tokens', 'relay revoke <token-id>', 'relay recover --skip <sequence>']) {
    assert.ok(usage.includes('pullboard ' + command), 'relay help lists pullboard ' + command);
  }
  const example = rest.split('\nExample:\n')[1].trim();
  assert.equal(example, 'pullboard relay on --all', 'the example is one whole command a person can paste');
  assert.ok(!/--all \[/u.test(rest), 'flags name --all alone');
});
