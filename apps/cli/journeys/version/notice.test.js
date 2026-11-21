/** The release-check question is asked once on a fresh private machine home, and never answered for the person [C7,#12110]. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/next/take.js';
import { main } from '../../tests/fixtures/native.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';

const ASK = /^Check once a day for new pullboard releases\?/gmu;

/** Run a human status at a terminal that sends the given lines; the machine home is the fixture's private one. */
async function statusAt(box, lines) {
  let out = '';
  const stdin = Object.assign(Readable.from(lines), { isTTY: true });
  const code = await main(['status'], { cwd: box.root, clock: box.clock, stdin, stdout: { isTTY: true, write: (part) => { out += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, out);
  return out;
}

test('cli.journeys-version-notice.the-release-check-question-is-asked-once: clause 1: the release-check question is asked once, the answer is stored, and with no answer update.check stays off [C7,#12110]', async (t) => {
  const box = await fixture(t);
  assert.equal(loadMachineSettings().update?.check, undefined, 'the fresh private home has never answered');
  const first = await statusAt(box, ['\n']);
  assert.equal(first.match(ASK)?.length, 1, 'the first status prints the question');
  const unanswered = await statusAt(box, ['\n']);
  assert.equal(unanswered.match(ASK)?.length, 1, 'with no answer stored the question stays open');
  assert.equal(loadMachineSettings().update?.check, undefined, 'a blank line records no answer for the person');
  const answered = await statusAt(box, ['no\n']);
  assert.equal(answered.match(ASK)?.length, 1, 'the question prints once more, then takes the answer');
  assert.equal(loadMachineSettings().update.check, false, 'the answer is stored');
  const second = await statusAt(box, ['yes\n']);
  assert.doesNotMatch(second, ASK, 'the second status prints no question');
  assert.equal(loadMachineSettings().update.check, false, 'the stored answer is not replaced');
});
