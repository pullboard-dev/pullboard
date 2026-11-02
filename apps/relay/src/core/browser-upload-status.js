/** Authenticate a publisher's size refusal with the board key before showing any diagnosis [H5,H17]. */
import { unseal } from './seal.js';
import { ENGINE_VERSION } from './engine.js';
import { withBrowserDeadline } from './browser-deadline.js';
import { SNAPSHOT_BODY_BYTES, SEALED_SNAPSHOT_BYTES } from './relay-limits.js';
import { Refused } from './refused.js';

/** An absent or older endpoint is not evidence of an oversized board. */
export async function readUploadSize(documentAt, entry) {
  let document;
  try { document = await documentAt('/api/v1/boards/' + entry.id + '/upload-status'); }
  catch (error) { if (['NO_BOARD', 'NO_ENDPOINT', 'BAD_ROUTE'].includes(error.code)) return null; throw error; }
  if (document.status === null) return null;
  const encoded = document.status?.sealed;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{39,21846}$/u.test(encoded)) {
    throw new Refused('RELAY_RESPONSE', 'Refresh this board to read its sealed upload notice.');
  }
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const plain = await withBrowserDeadline(() => unseal(entry.key, bytes, { boardId: entry.id, kind: 'snapshot', sequence: 0 }));
  const value = JSON.parse(new TextDecoder().decode(plain));
  if (Object.keys(value).sort().join(',') !== 'board,engine,kind,limit,sealedBytes,version'
      || value.version !== 1 || value.kind !== 'snapshot-size-refusal' || value.board !== entry.id
      || !Number.isSafeInteger(value.engine) || value.engine < 1 || value.engine > ENGINE_VERSION
      || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > SEALED_SNAPSHOT_BYTES
      || !Number.isSafeInteger(value.sealedBytes) || value.sealedBytes <= value.limit || value.sealedBytes > SNAPSHOT_BODY_BYTES) {
    throw new Refused('RELAY_RESPONSE', 'Refresh this board to read its authenticated upload notice.');
  }
  return { repository: entry.repository, sealedBytes: value.sealedBytes, limit: value.limit };
}

