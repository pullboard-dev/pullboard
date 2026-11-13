/** Explicit native session capture never treats an omitted identity as a person shell [V1,B3,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordItemSession } from '../../index.js';
import { refuseSelfSession } from '../../index.js';
import { requireLedger } from '../../index.js';

/** Own only a disposable local ledger, without borrowing an actual checkout or session. */
function fixture(t) {
  const commonDir = mkdtempSync(join(tmpdir(), 'pullboard-item-session-port-'));
  t.after(() => rmSync(commonDir, { recursive: true, force: true }));
  return { commonDir };
}

test('an omitted session capture refuses before creating or reading the local ledger [V1,B3,C7]', t => {
  const info = fixture(t), item = { item_id: 1 };
  assert.throws(() => requireLedger(info), { code: 'SESSION_LEDGER' });
  assert.throws(() => recordItemSession(info, 1, 'submit'), { code: 'SESSION_LEDGER' });
  assert.throws(() => refuseSelfSession(info, item), { code: 'SESSION_LEDGER' });
  assert.equal(existsSync(join(info.commonDir, 'pullboard')), false);
  requireLedger(info, null);
  recordItemSession(info, 1, 'submit', null);
  refuseSelfSession(info, item, null);
  assert.equal(existsSync(join(info.commonDir, 'pullboard')), false, 'the explicit no-agent result retains its old no-ledger behavior');
});

test('a captured session retains its recorded self-review refusal and an unrelated positive [V1,B3,C7]', t => {
  const info = fixture(t), digest = 'a'.repeat(64), item = { item_id: 7 };
  requireLedger(info, digest);
  recordItemSession(info, 7, 'submit', digest);
  const rows = readFileSync(join(info.commonDir, 'pullboard', 'item-sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(({ item, move, digest }) => ({ item, move, digest })), [{ item: 7, move: 'submit', digest }]);
  assert.throws(() => refuseSelfSession(info, item, digest), { code: 'SELF_SESSION_VERIFY' });
  refuseSelfSession(info, item, 'b'.repeat(64));
  assert.equal(readFileSync(join(info.commonDir, 'pullboard', 'item-sessions.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('review.independence off lets a session that built the item verify, session keeps the refusal [V1,B3,C7]', t => {
  const info = fixture(t), digest = 'c'.repeat(64), item = { item_id: 9 };
  requireLedger(info, digest);
  recordItemSession(info, 9, 'submit', digest);
  refuseSelfSession(info, item, digest, [], { independence: 'off' });
  assert.throws(() => refuseSelfSession(info, item, digest, [], { independence: 'session' }), { code: 'SELF_SESSION_VERIFY' });
});
