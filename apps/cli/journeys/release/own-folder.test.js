/** A release run from inside its own item folder exits 0 with its normal output; the folder goes only after the command's last step [B5,#10891]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { main } from '../../tests/fixtures/native.js';

test('cli.journeys-release-own-folder.release-from-its-own-item-folder: clause 1: release run from inside its own item folder exits 0, prints released #N and its next step while the folder still stands, and the folder is gone when the command returns [B5,#10891]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  const id = box.add('Released from inside its own item folder');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = claimed.document.itemFolder;
  assert.ok(folder && existsSync(folder), 'the live claim has its own item folder');
  let out = '', err = '';
  const standing = [];
  // The agent's own command line, run with the item folder as its working folder, in text mode.
  const code = await main(['release', String(id), '--reason', 'OTHER', '--note', 'Release from inside the item folder'], { cwd: folder, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; standing.push(existsSync(folder)); } },
    stderr: { write: part => { err += part; } } });
  assert.equal(code, 0, out + err);
  assert.doesNotMatch(out + err, /ERR_MODULE_NOT_FOUND|uv_cwd|ENOENT/u);
  assert.match(out, new RegExp(`released #${id}\\b`, 'u'));
  assert.match(out, /^next: \S/mu, 'the release prints its next step');
  assert.ok(standing.length > 0 && standing.every(Boolean), 'the folder the command runs in stands while the command writes its output');
  assert.equal(existsSync(folder), false, 'the folder is gone once the command returns');
});
