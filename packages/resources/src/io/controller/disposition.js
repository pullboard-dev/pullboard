/** Native orphan disposal can settle only the exact original lease, once [C7,P3]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Refused } from '../../../../kernel/light.js';

/** Public recovery evidence identifies a lease without publishing its private bearer token. */
export function leaseTokenDigest(token) { return createHash('sha256').update(token).digest('hex'); }

/** Consume matching native disposal inside the queue transaction, never a diagnostic-file assertion. */
export function consumeControllerDisposition(db, owner, operation, cancellation) {
  const digest = leaseTokenDigest(owner.token);
  const candidates = db.prepare("SELECT id,detail FROM runner_recovery_event WHERE host=? AND kind IN ('cleanup','orphan-requeued') AND json_extract(detail,'$.leaseDigest')=?")
    .all(owner.host, digest);
  for (const row of candidates) {
    let detail;
    try { detail = JSON.parse(row.detail); } catch { continue; }
    if (detail.reason !== 'controller-orphan' || detail.holderPid !== owner.pid
      || detail.holderStarted !== owner.started || !Number.isSafeInteger(detail.controllerPid)
      || typeof detail.controllerStarted !== 'string' || !detail.controllerStarted
      || detail.source !== owner.repo) continue;
    const sourceLoss = ['source directory is gone', 'source directory identity changed'].includes(detail.cause);
    if (operation === 'cancel' ? !sourceLoss || cancellation?.version !== 1 || cancellation.root !== detail.source
      : operation !== 'requeue' || detail.cause !== 'controller process is gone') continue;
    if (db.prepare("SELECT 1 FROM runner_recovery_event WHERE kind='lease-disposition' AND json_extract(detail,'$.cleanup')=?").get(row.id)) continue;
    db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)').run(randomUUID(), owner.host,
      new Date().toISOString(), 'lease-disposition', JSON.stringify({ cleanup: row.id, leaseDigest: digest, operation }));
    return;
  }
  throw new Refused('RESOURCE_LEASE_LOST', 'the remote lease has no exact unconsumed native disposal for this transition');
}

/** A cancellation records failure once; prior native pruning already quarantined the disposed lease. */
export function settleControllerCancellation(db, owner, cancellation, recordRunnerFailure) {
  const holder = db.prepare('SELECT pid,started,runner FROM holder WHERE token=?').get(owner.token);
  if (!holder) consumeControllerDisposition(db, owner, 'cancel', cancellation);
  else {
    if (holder.pid !== owner.pid || holder.started !== owner.started || holder.runner !== owner.host)
      throw new Refused('RESOURCE_LEASE_LOST', 'source cancellation does not own this remote lease incarnation');
    recordRunnerFailure(db, owner.host, 'cleanup-unverified', cancellation.diagnostic);
  }
}
