/** Private native claim anchors feed authenticated numeric records, never transcript bytes [N2,C7]. */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/light.js';
import {
  mainPolicy,
  policyAt,
  trunkRef,
} from '../../../../../packages/sandbox/light.js';
import { tryGit } from '../../../../../packages/git/index.js';

// This module is itself imported only once exit rules are on, so a command on a board without them never pays for these cells [C7].
const [statsCell, itemsCell, storeCell] = await Promise.all([
  import('../../../../../packages/stats/index.js'),
  import('../../../../../packages/items/index.js'),
  import('../../../../../packages/store/index.js'),
]);
/** The stats cell, loaded with this module. */
function stats() { return statsCell; }
/** The items cell's session digests, loaded with this module. */
function items() { return itemsCell; }
/** The store's exit claims, loaded with this module. */
function store() { return storeCell; }

/** Read only the same regular native transcript and verify its complete claim prefix. */
function sourceBytes(source, previous) {
  if (!source) return null;
  let fd;
  try {
    fd = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd), bytes = readFileSync(fd);
    if (!stat.isFile() || previous && (stat.dev !== previous.dev || stat.ino !== previous.ino
      || bytes.length < previous.bytes || digest(bytes.subarray(0, previous.bytes)) !== previous.sha256)) return null;
    return { bytes, dev: stat.dev, ino: stat.ino, length: bytes.length, sha256: digest(bytes) };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A private prefix digest proves append-only custody without publishing native identifiers. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** One private file per immutable claim; a lost anchor is unknown rather than a fresh allowance. */
function anchorFile(ctx, claim) { return join(ctx.info.commonDir, 'pullboard', `exit-anchor-${claim}.json`); }

/** Capture once after the real claim; renewals and later commands never recreate missing anchors. */
export function captureExitAnchor(ctx, board, id, actor) {
  const claim = store().exitClaim(board, id, actor);
  if (!claim) return;
  try {
    const { nativeToolCallIds, sessionSnapshot, sessionSource } = stats();
    const source = sessionSource(), observed = sourceBytes(source);
    const calls = observed ? nativeToolCallIds(source.provider, observed.bytes) : null;
    const baseline = source ? sessionSnapshot(source) : null;
    const prefix = observed ? { dev: observed.dev, ino: observed.ino, bytes: observed.length, sha256: observed.sha256 } : null;
    mkdirSync(join(ctx.info.commonDir, 'pullboard'), { recursive: true, mode: 0o700 });
    writeFileSync(anchorFile(ctx, claim.key), JSON.stringify({ actor, item: id, claim: claim.key, source, prefix, baseline, calls }), { flag: 'wx', mode: 0o600 });
  } catch { ctx.io.err?.('Exit-rule native anchor unavailable; usage remains unknown, never a fresh zero.'); }
}

/** Derive one exact claim's counters; all unverified, reset or malformed native evidence stays unknown. */
function counters(ctx, claim, actor, item) {
  let fd;
  try {
    fd = openSync(anchorFile(ctx, claim.key), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16 * 1024 * 1024) return { tokens: null, calls: null };
    const anchor = JSON.parse(readFileSync(fd, 'utf8'));
    if (anchor.actor !== actor || anchor.item !== item || anchor.claim !== claim.key || !anchor.prefix) return { tokens: null, calls: null };
    const observed = sourceBytes(anchor.source, anchor.prefix);
    if (!observed) return { tokens: null, calls: null };
    const { nativeToolCallIds, sessionSnapshot, usageDifference } = stats();
    const ids = nativeToolCallIds(anchor.source.provider, observed.bytes);
    const calls = ids && Array.isArray(anchor.calls) ? ids.filter(id => !anchor.calls.includes(id)).length : null;
    const current = sessionSnapshot(anchor.source, anchor.baseline);
    const delta = usageDifference(anchor.baseline, current, null);
    const tokens = delta.reduce((sum, row) => sum === null || row.inputTokens === null || row.outputTokens === null
      || !Number.isSafeInteger(sum + row.inputTokens + row.outputTokens) ? null : sum + row.inputTokens + row.outputTokens, 0);
    return { tokens, calls };
  } catch { return { tokens: null, calls: null }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Check every external command before dispatch; this function never signals another process. */
export async function enforceExitBoundary(io, command) {
  if (['init', 'settings', 'hook', 'mcp', 'view', 'serve'].includes(command)) return;
  const { context } = await import('../read.js');
  let ctx;
  try { ctx = context(io); }
  catch (error) { if (['NO_REPO', 'NOT_A_REPO', 'NO_CONFIG'].includes(error.code) || (command === 'doctor' && error.code === 'CORE_BARE')) return; throw error; }
  if (ctx.info.isMain) return;
  let policy;
  try { policy = mainPolicy(ctx.info.root); }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'NO_POLICY') throw error;
    const ref = trunkRef(ctx.info.root);
    const resolved = ref && tryGit(ctx.info.root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!resolved || resolved.status !== 0) throw error;
    policy = policyAt(ctx.info.root, resolved.stdout.trim());
  }
  if (policy.config.exitRules?.enabled !== true) return;
  const { withBoard } = await import('../context.js');
  await io.prepareProcessPorts?.();
  ctx.nativeBoard = io.nativeBoard ??= await io.loadNativeBoard();
  const { seatAt: agentAt } = await import('../item/folder/identity.js');
  const { ordered } = await import('../claim.js');
  const { exitClaim, exitedSessionIdentity, requireExitActive } = store();
  const { parentSessionDigest, runtimeSessionIdentity } = items();
  await withBoard(ctx, async board => {
    const native = runtimeSessionIdentity();
    const stopped = native?.session ? exitedSessionIdentity(board, parentSessionDigest(native.session)) : null;
    if (stopped && command !== 'release') throw new Refused(stopped.code, 'this native session handed off its work; stop and let a fresh same-family session continue');
    const actor = agentAt(board, ctx.info.root)?.agent_id;
    if (!actor) return;
    const held = board.db.prepare("SELECT item_id FROM item WHERE item_owner=? AND item_status='claimed'").all(actor);
    for (const item of held) {
      const claim = exitClaim(board, item.item_id, actor);
      if (claim) await ordered(ctx, board, 'recordExitProgress', [{ agentId: actor, item: item.item_id, claim: claim.key, ...counters(ctx, claim, actor, item.item_id) }]);
    }
    // Release is the sole recovery write: it atomically validates and records the structured summary.
    if (command !== 'release') requireExitActive(board, actor, command);
  });
}

/**
 * Refuse a new claim from a session whose last call's prompt reached the context ceiling, so the next item starts fresh.
 * Why: the ceiling counts across claims; one long session re-read 728K tokens per call on 5 Nov. Unknown usage never refuses.
 */
export function contextCeilingRefusal(policy) {
  if (policy?.enabled !== true) return null;
  const { exitContextDecision, nativeLastPrompt, sessionSource } = stats();
  const source = sessionSource(), observed = sourceBytes(source);
  const last = observed ? nativeLastPrompt(source.provider, observed.bytes) : null;
  const decision = exitContextDecision(policy, last);
  return decision ? new Refused(decision.code, `this session's last call read ${decision.context} tokens (ceiling ${decision.ceiling}); end it and let a fresh session of the same seat take the next item`,
    'finish nothing more here: end this session; a fresh session of the same seat claims the next item') : null;
}
