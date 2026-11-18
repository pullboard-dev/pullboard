/** @pullboard-test-input source-cell apps/relay */
/** A sealed wake-up carries a kind and a sealed blob and no board text [H5,N26]. */
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createDecipheriv } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { WAKEUP_KINDS } from '../../index.js';
import { buildWakeup } from '../../index.js';
import { openWakeup } from '../../index.js';

const key = randomBytes(32);

function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

function open(blob) {
  const buf = Buffer.from(blob);
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

test('relay.logic-push-wakeup.buildwakeup-carries-no-plaintext-notice-byte: clause 1: buildWakeup carries no plaintext notice byte and the client opens it to a one-line notice [H5,N26]', () => {
  const text = 'Decision waiting on Deploy the staging board\nsecond line';
  const bytes = buildWakeup('decisions', seal(text));
  assert.equal(Buffer.from(bytes).includes(Buffer.from(text.split('\n')[0])), false);
  for (const word of ['Decision', 'staging', 'Deploy']) assert.equal(Buffer.from(bytes).includes(Buffer.from(word)), false);
  const opened = openWakeup(bytes, open);
  assert.deepEqual(opened, { kind: 'decisions', notice: 'Decision waiting on Deploy the staging board' });
});

test('relay.logic-push-wakeup.kinds-are-decisions-alerts-and-landings: clause 2: kinds are decisions, alerts and landings and any other kind is refused with its next step [H5,N26]', () => {
  assert.deepEqual([...WAKEUP_KINDS], ['decisions', 'alerts', 'landings']);
  for (const kind of WAKEUP_KINDS) assert.equal(openWakeup(buildWakeup(kind, seal('x')), open).kind, kind);
  assert.throws(() => buildWakeup('gossip', seal('x')), error => error.code === 'WAKEUP_KIND' && /decisions, alerts, landings/u.test(error.message));
  assert.throws(() => openWakeup(Uint8Array.from([9, 1, 2]), open), error => error.code === 'WAKEUP_KIND');
});
