/** One push subscription per paired device: stored, woken through an injected fetch, ended on revoke [C7]. */
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';
import { encryptPush } from '../../logic/push/encrypt.js';
import { vapidAuth } from '../../logic/push/vapid.js';
import { buildWakeup } from '../../logic/push/wakeup.js';

/**
 * Create the push subscription store and sender.
 * Why: a phone that is not open still learns something needs it; the relay sends only a sealed wake-up, and only with relay.push on.
 * @param {{ directory: string, enabled: () => boolean, fetch: typeof fetch, vapidKey: string, vapidPublic: string, subject: string, now?: () => number }} options
 */
export function createPushSubscriptions({ directory, enabled, fetch: send, vapidKey, vapidPublic, subject, now = Date.now }) {
  let db;
  /** Open storage only when used, so a relay with push off never creates the file. */
  function database() {
    if (db) return db;
    const file = join(directory, 'push.sqlite');
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec('CREATE TABLE IF NOT EXISTS push_subscription (account TEXT NOT NULL, device TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, PRIMARY KEY(account,device))');
    return db;
  }
  return {
    /** Store (or replace) the device's one subscription; with relay.push off, store nothing and report false. */
    subscribe(account, device, subscription) {
      if (!enabled()) return false;
      const { endpoint, keys } = subscription ?? {};
      if (typeof endpoint !== 'string' || !/^https:\/\//u.test(endpoint) || !keys?.p256dh || !keys?.auth) throw new Refused('PUSH_SUBSCRIPTION', 'Send the browser subscription: an https endpoint with its p256dh and auth keys.');
      database().prepare('INSERT OR REPLACE INTO push_subscription(account,device,endpoint,p256dh,auth) VALUES(?,?,?,?,?)').run(account, device, endpoint, keys.p256dh, keys.auth);
      return true;
    },
    /** End the device's subscription, as when its pairing is revoked. */
    revoke(account, device) {
      if (!db && !enabled()) return;
      database().prepare('DELETE FROM push_subscription WHERE account=? AND device=?').run(account, device);
    },
    /** Send a sealed wake-up of this kind to every subscribed device of the account; returns how many pushes were accepted. */
    async wake(account, kind, sealedBlob) {
      if (!enabled()) return 0;
      const wakeup = buildWakeup(kind, sealedBlob);
      const rows = database().prepare('SELECT endpoint,p256dh,auth FROM push_subscription WHERE account=?').all(account);
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
