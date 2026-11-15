/**
 * The landing permit: the board's receipt for one land job's current lease, carried by the job's trunk push as git push
 * options, and the trunk guard's verdict on a push. Main moves only with a landing receipt [B3,P7].
 * Why a MAC over the lease: the trunk remote may not reach the board, so it checks the permit with a shared key alone;
 * the permit names the lease's end, so a runner whose lease lapsed cannot push with it.
 * This file imports only node: built-ins, since the trunk guard installs a copy of it into the trunk remote.
 */
import { createHmac } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';

const VERSION = 'pullboard-landing-permit/1';
const PREFIX = 'pullboard-';
const ZERO = /^0+$/u;
const HEX = /^[0-9a-f]{64}$/u;

/**
 * The permit MAC for one land job's lease: hex HMAC-SHA256 under the board's landing key.
 *
 * @param {string} key - The board's landing key, shared with the trunk guard.
 * @param {{ job: string, runner: string, leaseUntil: number, trunk: string }} fields
 * @returns {string}
 */
export function landingPermit(key, { job, runner, leaseUntil, trunk }) {
  return createHmac('sha256', String(key)).update([VERSION, job, runner, String(leaseUntil), trunk].join('\n')).digest('hex');
}

/**
 * The git push options a land job's trunk push carries: its job, runner, lease end and permit MAC.
 *
 * @param {{ job: string, runner: string, leaseUntil: number, mac: string }} permit
 * @returns {string[]}
 */
export function permitPushOptions({ job, runner, leaseUntil, mac }) {
  return [`${PREFIX}job=${job}`, `${PREFIX}runner=${runner}`, `${PREFIX}lease-until=${leaseUntil}`, `${PREFIX}permit=${mac}`];
}

/** The permit a push's options carry, or null when they carry none or a malformed one. */
export function readPermitOptions(options) {
  const one = name => options.filter(option => option.startsWith(`${PREFIX}${name}=`)).map(option => option.slice(PREFIX.length + name.length + 1));
  const [job] = one('job'), [runner] = one('runner'), [until] = one('lease-until'), [mac] = one('permit');
  if (!job || !runner || !/^\d{1,16}$/u.test(until ?? '') || !HEX.test(mac ?? '')) return null;
  return { job, runner, leaseUntil: Number(until), mac };
}

/**
 * The trunk guard's verdict on one push: every update to the trunk ref must carry a valid permit whose lease is live
 * and fast-forward trunk. Other refs pass. Why no item check: a chained job may drop a culprit and still land [C7].
 *
 * @param {{ updates: { old: string, new: string, ref: string }[], options: string[], key: string | null, trunk: string, now: number,
 *   isAncestor: (ancestor: string, of: string) => boolean | Promise<boolean> }} push
 * @returns {Promise<{ ok: true } | { ok: false, code: string, reason: string }>}
 */
export async function trunkPushVerdict({ updates, options, key, trunk, now, isAncestor }) {
  const refuse = (code, reason) => ({ ok: false, code, reason });
  for (const update of updates) {
    if (update.ref !== trunk) continue;
    if (ZERO.test(update.new)) return refuse('TRUNK_DELETE', `${trunk} cannot be deleted`);
    if (!key) return refuse('TRUNK_GUARD_KEY', 'this trunk guard has no landing key; reinstall it with the board\'s key');
    const permit = readPermitOptions(options);
    if (!permit) return refuse('TRUNK_RECEIPT', `a push to ${trunk} must carry a landing job's receipt and lease; land through pullboard, never by hand`);
    const want = Buffer.from(landingPermit(key, { ...permit, trunk })), got = Buffer.from(permit.mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse('TRUNK_RECEIPT', `the landing receipt for job ${permit.job} is not valid for ${trunk}; land through pullboard`);
    if (permit.leaseUntil < now) return refuse('TRUNK_LEASE', `job ${permit.job}'s lease lapsed; the runner holding it now lands it`);
    if (!ZERO.test(update.old) && !await isAncestor(update.old, update.new)) return refuse('TRUNK_REWRITE', `the push does not fast-forward ${trunk}`);
  }
  return { ok: true };
}
