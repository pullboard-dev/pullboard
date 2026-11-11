/** Confirm migration refuses an unrecognized remote prefix as a focused relay fixture helper [H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { ENGINE_VERSION } from '../../../../../../../packages/state/index.js';

/** Confirm migration refuses an unrecognized remote prefix before executing another local move. */
export async function legacyForeignPrefixFragment({
  relay, root, relayEnv, boardFile, linkFile, lane, boardId, currentMachineToken, localEvents, cliResult,
}) {
  const originalLink = readFileSync(linkFile, 'utf8');
  const link = JSON.parse(originalLink);
  assert.equal(link.mode, 'ordered');
  link.cursor = localEvents(boardFile).at(-1)?.event_id ?? 0;
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });

  const foreign = await fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
    method: 'POST',
    headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${currentMachineToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: link.sequence + 1, sealed: 'AQ' }),
  });
  assert.equal(foreign.status, 200, await foreign.text());

  const beforeAttempt = localEvents(boardFile);
  const refused = await cliResult(root, relayEnv, 'add', lane, 'must not follow a foreign prefix');
  assert.equal(refused.status, 1);
  assert.equal(refused.document.error.code, 'RELAY_DIVERGED');
  assert.match(refused.document.error.message, new RegExp(`relay sequence ${link.sequence + 1}.*local sequence ${link.sequence}`));
  assert.match(refused.document.error.next, /relay off.*relay on.*pairing/);
  assert.deepEqual(localEvents(boardFile), beforeAttempt, 'a foreign prefix is refused before the CLI move applies');

  writeFileSync(linkFile, originalLink, { mode: 0o600 });
}



