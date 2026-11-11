/** Native, append-ordered push evidence; caller filing assertions are never authority [C7]. */
import { createHash } from 'node:crypto';
import { gitSpawnSync } from "./adapter.js";
import {
  git,
  gitChildEnv,
} from "./main.js";
import { landingBatches } from '../logic/batches.js';
import { pushCommandDigest } from "./receipts.js";

/**
 * Bind an ordered event to private bytes, source tree and its own pinned policy: ordinary landings name the
 * accepted main at execution; collection audits name the audited head. Today's command is not retroactive authority.
 */
function boundRun(root, board, run, { boardReceiptStore, readGateReceipt, receiptBinds, coordinator, policyAt }) {
  const store = boardReceiptStore(board);
  const receipt = readGateReceipt(store, run.id);
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'land'
    || run.by !== coordinator || !receiptBinds(store, run)) return null;
  try {
    if (receipt.command !== pushCommandDigest(policyAt(root, receipt.main).config.gate)) return null;
    if (git(root, ['rev-parse', '--verify', `${receipt.head}^{tree}`]).trim() !== receipt.tree) return null;
  } catch { return null; }
  return receipt;
}

/** Require an identified failure's native defect to bind the audited blob and a still-open repair item. */
function filedFailure(root, board, audit, failure, defects, getItem) {
  let bytes;
  let blob;
  try {
    const read = gitSpawnSync(['--no-replace-objects', 'show', `${audit.head}:${failure.file}`],
      { cwd: root, env: gitChildEnv(root), encoding: null, stdio: ['ignore', 'pipe', 'pipe'] });
    if (read.status !== 0 || read.signal || read.error || !Buffer.isBuffer(read.stdout)) return false;
    bytes = read.stdout;
    blob = git(root, ['rev-parse', '--verify', `${audit.head}:${failure.file}`]).trim();
  } catch { return false; }
  const hash = createHash('sha256').update(bytes).digest('hex');
  return defects.some(defect => {
    if (defect.batchId !== audit.collection.batchId || defect.test !== failure.file
      || defect.blob !== blob || defect.hash !== hash || !defect.names?.includes(failure.name)) return false;
    try { return ['open', 'claimed', 'submitted'].includes(getItem(board, defect.item).item_status); }
    catch { return false; }
  });
}

/** Read current native batches, runs and defect links; missing or incomplete evidence fails closed. */
export function nativePushReceiptProblems(root, board, commits, ports) {
  const problems = [];
  const batches = landingBatches(board).filter(batch => batch.state === 'landed');
  const landedEvents = new Map();
  for (const row of board.db.prepare("SELECT event_id,event_detail FROM event WHERE event_kind='landing_batch' ORDER BY event_id").all()) {
    const { batch } = JSON.parse(row.event_detail);
    if (batch.state === 'landed' && !landedEvents.has(batch.id)) landedEvents.set(batch.id, row.event_id);
  }
  const runs = ports.gateRuns(board);
  for (const commit of commits) {
    const covered = runs.some(run => {
      const receipt = boundRun(root, board, run, ports);
      return receipt?.green === true && receipt.head === commit
        && batches.some(batch => batch.tip === commit && batch.proof?.tree === receipt.tree
          && run.eventId < landedEvents.get(batch.id));
    });
    if (!covered) problems.push(`commit ${commit} lacks its exact native green landing receipt`);
  }
  // Choose the latest native collection event before validating it: never fall back to an older green audit.
  const latest = runs.filter(run => Object.hasOwn(run, 'collection')).at(-1);
  const audit = latest && boundRun(root, board, latest, ports);
  const collection = audit?.collection;
  const batch = collection && batches.find(entry => entry.id === collection.batchId);
  if (!audit || !batch || batch.tip !== audit.head || batch.proof?.tree !== audit.tree
    || collection.complete !== true || collection.full !== true || collection.plannedFiles < 1) {
    problems.push('the latest native audit lacks complete, source-bound full collection evidence');
    return problems;
  }
  if (!audit.green) {
    if (!audit.failures.length) problems.push('the latest native audit is red without identified failures');
    const defects = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing-test-defect' ORDER BY event_id").all()
      .map(row => JSON.parse(row.event_detail).defect);
    for (const failure of audit.failures) {
      if (!filedFailure(root, board, audit, failure, defects, ports.getItem)) problems.push(`audit failure ${failure.file} :: ${failure.name} lacks a native open repair link`);
    }
  }
  return problems;
}
