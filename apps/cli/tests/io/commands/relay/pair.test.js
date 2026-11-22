/** @pullboard-test-input apps/cli/tests/io/commands/relay/pair.test.js */
/** @pullboard-test-input source-cell apps/cli */
/** Relay pair command proof: code and phone labels [H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { relayClientFixture } from '../../../fixtures/relay/client.js';

test('cli.journeys-relay-setup.relay-pair-labels-the-code-for: clause 1: relay pair labels the code for a computer and the QR for a phone [H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../../fixtures/native.js')).href;
  const result = await box.script(`
import { main } from ${JSON.stringify(cliModule)};
let output = '';
const streams = { cwd: ${JSON.stringify(box.root)}, stdout: { write: part => { output += part; } }, stderr: { write() {} } };
const code = await main(['relay', 'pair'], streams);
process.stdout.write(JSON.stringify({ code, lines: output.split('\\n') }));
`);
  assert.equal(result.code, 0, 'the private pair script completes');
  const { code, lines } = result.document;
  assert.equal(code, 0, 'relay pair publishes a code');
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const computer = lines.findIndex(line => line.startsWith('For another computer: '));
  assert.ok(computer >= 0, 'the one-time code is labelled for another computer');
  assert.match(lines[computer], new RegExp('run pullboard init, then pullboard relay join ' + board + '\\.[A-Za-z0-9_.-]+ --url '
    + box.origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '\\. The code works once, for 10 minutes\\.$', 'u'),
    'the computer line is the relay join command for this relay');
  const phone = lines.findIndex(line => line.startsWith('For a phone: scan this QR code'));
  assert.ok(phone > computer, 'the QR is labelled for a phone');
  assert.ok(lines[phone].includes(box.origin + '/#board=' + board), 'the phone link uses the relay this board is linked to');
  assert.ok((lines[phone + 1] ?? '').startsWith('\u001b[30;47m'), 'the QR follows its phone label');
  assert.ok(!lines.join('\n').includes('app.pullboard.dev'), 'a board on another relay never points at the hosted default');
});

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const PAIR_ID = 'cli.journeys-relay-setup.relay-pair-labels-the-code-for';

/** @pullboard-world-pin: clause 2 reads the pair test, setup test and registry to verify this split in the committed tree. */
test('cli.journeys-relay-setup.pair-case-preserves-setup-cases: clause 2: the moved pair case has one record and setup keeps its unselected cases [C7,H17]', () => {
  const pair = readFileSync(resolve(ROOT, 'apps/cli/tests/io/commands/relay/pair.test.js'), 'utf8');
  const setup = readFileSync(resolve(ROOT, 'apps/cli/journeys/relay/setup.test.js'), 'utf8');
  const registry = readFileSync(resolve(ROOT, 'apps/cli/tests/fixtures/registry-10548.json'), 'utf8');
  assert.equal(registry.split(`"${PAIR_ID}"`).length - 1, 1, 'the selected ID has exactly one registry record');
  assert.equal(pair.split(`test('${PAIR_ID}:`).length - 1, 1, 'the selected case is in the pair test exactly once');
  assert.equal(setup.split(`test('${PAIR_ID}:`).length - 1, 0, 'the selected case was removed from setup');
  for (const id of ['cli.journeys-relay-setup.the-approval-wait-names-the-phone', 'cli.journeys-relay-setup.relay-on-all-says-who-signed']) {
    assert.ok(setup.includes(`test('${id}:`), `${id} remains in setup`);
  }
});

