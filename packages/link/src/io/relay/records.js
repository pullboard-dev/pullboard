import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { Refused } from '../../../../kernel/light.js';
import { seal } from '../../../../kernel/index.js';
import { unseal } from '../../../../kernel/index.js';

const MOVE_BYTES = 32 * 1024 * 1024;

/** Seal snapshots as gzip while keeping move writes in the existing plain JSON format. */
export async function sealRelayRecord(key, value, state, kind, sequence) {
  const plain = Buffer.from(JSON.stringify(value));
  const content = kind === 'snapshot' ? gzipSync(plain) : plain;
  return sealRelayPayload(key, content, state, kind, sequence);
}

/** Seal already encoded bytes under the exact board, record kind and sequence binding. */
export async function sealRelayPayload(key, payload, state, kind, sequence) {
  return Buffer.from(await seal(key, payload, { boardId: state.board, kind, sequence })).toString('base64url');
}

/** Authenticate a canonical base64url record before returning its encoded payload. */
export async function unsealRelayRecord(key, record, state, kind, sequence) {
  const bytes = Buffer.from(record.sealed, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== record.sealed) throw new Refused('RELAY_RESPONSE', 'the relay returned invalid sealed bytes; fetch the board again');
  return unseal(key, bytes, { boardId: state.board, kind, sequence });
}

/** Authenticate and decode snapshots or move records, retaining legacy JSON and bounding move inflation. */
export async function decodeRelayRecord(key, record, state, kind, sequence) {
  const plain = await unsealRelayRecord(key, record, state, kind, sequence);
  try {
    if (kind === 'snapshot') {
      if (plain[0] === 0x1f && plain[1] === 0x8b) return JSON.parse(gunzipSync(plain).toString('utf8'));
      if (plain[0] !== 0x7b) throw new Refused('SNAPSHOT_FORMAT', `the sealed snapshot starts with ${Buffer.from(plain.subarray(0, 4)).toString('hex') || 'no bytes'}; expected gzip magic 1f8b or legacy JSON starting with 7b`);
    }
    if (kind === 'move' && plain[0] === 0x1f && plain[1] === 0x8b) {
      return JSON.parse(gunzipSync(plain, { maxOutputLength: MOVE_BYTES }).toString('utf8'));
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }
  catch (error) {
    if (error instanceof Refused) throw error;
    if (kind === 'snapshot') throw new Refused('SNAPSHOT_FORMAT', 'the sealed snapshot has gzip magic or legacy JSON bytes but cannot be read; refresh it from a linked machine');
    throw new Refused('RELAY_MOVE', 'the authenticated relay document is invalid; upgrade pullboard or restore a consistent snapshot');
  }
}
