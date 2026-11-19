/** One push subscription per paired device: stored, woken through an injected fetch, ended on revoke [C7]. */
import {
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';
import { encryptPush } from '../../logic/push/encrypt.js';
import { vapidAuth } from '../../logic/push/vapid.js';
import {
  WAKEUP_KINDS,
  buildWakeup,
} from '../../logic/push/wakeup.js';

/**
 * Create the push subscription store and sender.
 * Why: a phone that is not open still learns something needs it; the relay sends only a sealed wake-up, and only with relay.push on.
 * @param {{ directory: string, enabled: () => boolean, fetch: typeof fetch, vapidKey: string, vapidPublic: string, subject: string, now?: () => number }} options
 */
export function createPushSubscriptions({ directory, enabled, fetch: send, vapidKey, vapidPublic, subject, now = Date.now }) {
  const file = join(directory, 'push.sqlite');
  let db;
  /** Open storage only when used, so a relay with push off never creates the file. */
  function database() {
    if (db) return db;
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec('CREATE TABLE IF NOT EXISTS push_subscription (account TEXT NOT NULL, device TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, kinds TEXT NOT NULL DEFAULT \'\', PRIMARY KEY(account,device))');
    if (!db.prepare('PRAGMA table_info(push_subscription)').all().some(column => column.name === 'kinds')) db.exec("ALTER TABLE push_subscription ADD COLUMN kinds TEXT NOT NULL DEFAULT ''");
    return db;
  }
  return {
    /** Whether relay.push is on, so a caller can refuse a subscription before it asks for one. */
    enabled,
    /** The public VAPID key a paired page subscribes with, or null while relay.push is off. */
    publicKey: () => enabled() ? vapidPublic : null,
    /** Store (or replace) the device's one subscription with the kinds it chose (all kinds when none are named); with relay.push off, store nothing and report false. */
    subscribe(account, device, subscription, kinds = WAKEUP_KINDS) {
      if (!enabled()) return false;
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !WAKEUP_KINDS.includes(kind))) throw new Refused('PUSH_KINDS', `Choose at least one of ${WAKEUP_KINDS.join(', ')} to be woken for.`);
      const { endpoint, keys } = subscription ?? {};
      if (typeof endpoint !== 'string' || !/^https:\/\//u.test(endpoint) || !keys?.p256dh || !keys?.auth) throw new Refused('PUSH_SUBSCRIPTION', 'Send the browser subscription: an https endpoint with its p256dh and auth keys.');
      database().prepare('INSERT OR REPLACE INTO push_subscription(account,device,endpoint,p256dh,auth,kinds) VALUES(?,?,?,?,?,?)').run(account, device, endpoint, keys.p256dh, keys.auth, WAKEUP_KINDS.filter(kind => kinds.includes(kind)).join(','));
      return true;
    },
    /** Close the owned database before removing a private test or service directory. */
    close() { db?.close(); db = undefined; },
    /** The kinds a device is subscribed for, or null when it holds no subscription. */
    kinds(account, device) {
      if (!db && !existsSync(file)) return null;
      const row = database().prepare('SELECT kinds FROM push_subscription WHERE account=? AND device=?').get(account, device);
      return row ? row.kinds.split(',').filter(Boolean) : null;
    },
    /** End the device's subscription, as when its pairing is revoked; a stored one ends even after relay.push is switched off. */
    revoke(account, device) {
      if (!db && !existsSync(file)) return;
      database().prepare('DELETE FROM push_subscription WHERE account=? AND device=?').run(account, device);
    },
    /** Send a sealed wake-up of this kind to every subscribed device of the account; returns how many pushes were accepted. */
    async wake(account, kind, sealedBlob) {
      if (!enabled()) return 0;
      const wakeup = buildWakeup(kind, sealedBlob);
      const rows = database().prepare('SELECT endpoint,p256dh,auth,kinds FROM push_subscription WHERE account=?').all(account).filter(row => row.kinds === '' || row.kinds.split(',').includes(kind));
      let sent = 0;
      for (const row of rows) {
        const token = vapidAuth(row.endpoint, subject, vapidKey, now());
        const response = await send(row.endpoint, {
          method: 'POST',
          headers: { authorization: `vapid t=${token}, k=${vapidPublic}`, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '60' },
          body: encryptPush(wakeup, { p256dh: row.p256dh, auth: row.auth }),
        });
        if (response.ok) sent += 1;
      }
      return sent;
    },
  };
}
