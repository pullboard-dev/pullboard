/** A blocked upload probes small metadata and reports once per real device session [H15,H17]. */
import { createRelayPageCache } from '../../../../pages/index.js';
import { snapshotSourceId } from '../../../../pages/index.js';
import { relayStorage } from '../../../../pages/index.js';
import { relayStorageLine } from '../../../../pages/index.js';
export { relayStorage };
export { relayStorageLine };
import { agentSessionDigest } from '../../../../person/index.js';
import { Refused } from '../../../../kernel/light.js';
import { legacyPageRoute } from '../../../../pages/index.js';

/** Classify a durable transport limit without trusting arbitrary relay text as executable advice. */
export function uploadPauseType(pause) {
  if (pause?.code === 'ACCOUNT_STORAGE_LIMIT') return 'quota';
  if (pause?.size || /(?:exceeds?|over|larger than|too large).{0,40}(?:bytes|snapshot|limit)|(?:snapshot|limit).{0,40}(?:exceeds?|over|too large)/iu.test(pause?.message ?? '')) return 'size';
  return null;
}

/** Definitive quota and HTTP client refusals pause; throttling and uncertain transport failures retain exact retries. */
export function permanentUploadRefusal(error) {
  return error?.code === 'ACCOUNT_STORAGE_LIMIT' && error.httpStatus === 507 ||
    Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 425, 429].includes(error.httpStatus);
}

/** Ordinary commands never materialize or re-seal a known blocked snapshot just to rediscover its limit. */
export async function uploadRetryReady(state, pause, request) {
  const type = uploadPauseType(pause);
  if (!type) return true;
  if (type === 'size') {
    try {
      const ready = (await request('/api/v2')).apiVersion === 2;
      if (ready) state.snapshotApiVersion = 2;
      return ready;
    }
    catch (error) { if (legacyPageRoute(error)) return false; throw error; }
  }
  const result = await request('/api/v2/boards/' + state.board + '/storage');
  const storage = relayStorage(result.storage);
  if (result.apiVersion !== 2 || !storage) throw new Refused('RELAY_RESPONSE', 'Retry the configured relay to read the account storage limit.');
  state.storage = storage;
  return result.warning?.code !== 'ACCOUNT_STORAGE_LIMIT';
}

/** Hash an existing session identity locally; never change it or persist a raw shell marker. */
export function firstUploadPauseNotice(state) {
  const session = agentSessionDigest() ?? snapshotSourceId(process.env.TERM_SESSION_ID || 'terminal-parent:' + process.ppid);
  const cache = createRelayPageCache(state);
  try { return cache.firstNotice(session); } finally { cache.close(); }
}

/** End notice suppression only after a real accepted baseline or checkpoint, not a successful probe. */
export function clearUploadPauseNotices(state) {
  const cache = createRelayPageCache(state);
  try { cache.clearNotices(); } finally { cache.close(); }
}

/** Keep a permanent refusal only as a bounded, credential-free diagnostic. */
export function safePauseMessage(error) {
  const message = String(error.relayMessage ?? error.message ?? 'the relay refused the baseline upload')
    .replace(/https?:\/\/[^\s]+/gu, '[relay]')
    .replace(/\b(?:Bearer\s+)?(?:ps|pa|pm|pg)_[A-Za-z0-9_-]{20,}\b/gu, '[credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return message.slice(0, 240) || 'the relay refused the baseline upload';
}
