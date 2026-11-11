// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/relay/src/io/browser/passkeys.js apps/relay/src/io/browser/client.js apps/relay/src/io/passkeys.js src/person-signing.js apps/cli/tests/fixtures/person/trusted.js */
/** A real browser passkey confirms a person move a terminal started, with the person present, once [E22,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { test } from 'node:test';
import {
  findChromeExecutable,
  relayWorkBudgetMs,
  startChrome,
} from '../../tests/fixtures/relay/browser.js';
import {
  relayClientFixture,
  relayFixtureChild,
} from '../../tests/fixtures/relay/client.js';

test('a passkey on the paired browser confirms a terminal-started person move once [E22,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed', timeout: relayWorkBudgetMs(20),
}, async (t) => { // budget: hang ceiling for real CLI runs, Chrome and relay calls; not a speed target.
  // WebAuthn needs a domain for its RP id, so this relay is reached as localhost, not 127.0.0.1.
  const box = await relayClientFixture(t, { host: 'localhost' });
  const trustedEntry = join(import.meta.dirname, '../../tests/fixtures/person/trusted.js');
  /** Hand only this private test's relay origin to the explicit test entry, never the shipped binary. */
  const cli = (...args) => relayFixtureChild(box.root, box.env, [trustedEntry, box.origin, ...args, '--json']);
  assert.equal((await cli('add', box.lane, 'PASSKEY_BROWSER_READY')).code, 0);
  const ask = (await cli('shout', 'person', 'PASSKEY_BROWSER_DECISION', '--decision')).document.id;
  await box.link();
  assert.equal((await cli('settings', 'person.signed', 'on')).code, 0);
  const helpers = createE2eHelpers();
  const terminal = helpers.launch({ ...box, env: { ...box.env, SSH_CONNECTION: '127.0.0.1 40000 127.0.0.1 22' } },
    box.root, process.execPath, [trustedEntry, box.origin, 'answer', String(ask), 'Confirmed in the browser', '--as', 'person', '--json']);
  t.after(async () => { if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGTERM'); await terminal.closed; });
  await helpers.waitFor(() => { assert.equal(terminal.exitCode, null, terminal.stderrText); return terminal.stderrText.includes('this terminal is waiting'); },
    'the original SSH terminal waits for a passkey', relayWorkBudgetMs(5));

  const chrome = await startChrome();
  t.after(() => chrome.close());
  // A platform authenticator that reports the person present, as Touch ID does after a touch.
  await chrome.send('WebAuthn.enable', {});
  await chrome.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('PASSKEY_BROWSER_READY')");

  await chrome.waitFor("!!document.querySelector('#person-passkey-add')", relayWorkBudgetMs(), 'the page offers to add a passkey');
  await chrome.evaluate("document.querySelector('#person-passkey-add').click()");
  await chrome.waitFor("!!document.querySelector('[id^=person-confirm-]')", relayWorkBudgetMs(), 'the terminal-started move waits on the page');
  assert.match(await chrome.evaluate("document.querySelector('#person-passkeys').textContent"), /Answer decision #\d+: Confirmed in the browser/u);
  await chrome.evaluate("document.querySelector('[id^=person-confirm-]').click()");
  await chrome.waitFor("!document.querySelector('[id^=person-confirm-]')", relayWorkBudgetMs(), 'one confirmation sends the move');

  const outcome = await terminal.closed;
  assert.equal(outcome.code, 0, terminal.stderrText);
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  let answers;
  try { answers = db.prepare('SELECT * FROM shout WHERE shout_answers=?').all(ask); }
  finally { db.close(); }
  // No second CLI invocation runs between starting the terminal and observing its committed answer.
  assert.deepEqual(answers.map((row) => [row.shout_from, row.shout_text]), [['person', 'Confirmed in the browser']]);
});
