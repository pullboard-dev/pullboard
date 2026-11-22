/** @pullboard-test-input apps/cli/journeys/relay/setup.test.js */
/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runCliInProcess } from '../../../fixtures/process.js';

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const HELP_ID = 'cli.journeys-relay-setup.relay-help-lists-every-relay-command';

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

/** @pullboard-world-pin: clause 2 reads the help test, relay setup test and registry to verify this split in the committed tree. */
test('cli.journeys-relay-setup.help-case-preserves-setup-cases: clause 2: the moved help case has one record and setup keeps its unselected cases [C7,H17]', () => {
  const help = readFileSync(resolve(ROOT, 'apps/cli/tests/io/commands/relay/help.test.js'), 'utf8');
  const setup = readFileSync(resolve(ROOT, 'apps/cli/journeys/relay/setup.test.js'), 'utf8');
  const registry = readFileSync(resolve(ROOT, 'apps/cli/tests/fixtures/registry-10548.json'), 'utf8');
  assert.equal(registry.split(`"${HELP_ID}"`).length - 1, 1, 'the selected ID has exactly one registry record');
  assert.equal(help.split(`test('${HELP_ID}:`).length - 1, 1, 'the selected case is in the new help test exactly once');
  assert.equal(setup.split(`test('${HELP_ID}:`).length - 1, 0, 'the selected case was removed from setup');
  for (const id of ['cli.journeys-relay-setup.relay-pair-labels-the-code-for', 'cli.journeys-relay-setup.the-approval-wait-names-the-phone',
    'cli.journeys-relay-setup.relay-on-all-says-who-signed']) {
    assert.ok(setup.includes(`test('${id}:`), `${id} remains in setup`);
  }
});
