/** Read-only push evidence: exact first-parent landings and the newest complete audit [C7]. */
import { createHash } from 'node:crypto';
import {
  git,
  refuseGrafts,
} from "./main.js";
import { Refused } from "../../../kernel/light.js";

const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ZERO = /^0+$/u;

/** Refuse an incomplete push range rather than dropping an unknown object from the check. */
function rangeRefusal() {
  return new Refused('PUSH_RECEIPT_RANGE', 'restore complete local and remote commit history, then retry the push receipt check');
}

/** Expand Git's actual pre-push records, deduplicating first-parent commits across all updated refs. */
export function pushedFirstParentCommits(root, refsText) {
  refuseGrafts(root);
  const commits = new Set();
  for (const line of refsText.split(/\r?\n/u).filter(line => line.trim())) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4 || !OBJECT.test(fields[1]) || !OBJECT.test(fields[3])
      || !fields[2].startsWith('refs/')) throw rangeRefusal();
    const [, local, , remote] = fields;
    if (ZERO.test(local)) continue; // Deleting a ref introduces no code.
    try {
      const tip = git(root, ['rev-parse', '--verify', `${local}^{commit}`]).trim();
      const base = ZERO.test(remote) ? null : git(root, ['rev-parse', '--verify', `${remote}^{commit}`]).trim();
      const listed = git(root, ['rev-list', '--first-parent', '--reverse', tip, ...(base ? ['--not', base] : [])]);
      for (const commit of listed.split('\n').filter(Boolean)) {
        if (!OBJECT.test(commit)) throw rangeRefusal();
        commits.add(commit);
      }
    } catch { throw rangeRefusal(); }
  }
  return [...commits];
}

/** Hash the accepted command, never a caller's timing-log description. */
export function pushCommandDigest(command) {
  return createHash('sha256').update(command).digest('hex');
}

/** A receipt proves only its exact committed source and accepted command, never a descendant. */
function exactReceipt(root, id, command, commit, kind, { readGateReceipt, receiptStore }) {
  const receipt = readGateReceipt(receiptStore(root), id);
  if (!receipt || receipt.version !== 1 || receipt.kind !== kind || receipt.command !== pushCommandDigest(command)
    || commit !== undefined && receipt.head !== commit) return null;
  try {
    if (git(root, ['rev-parse', '--verify', `${receipt.head}^{tree}`]).trim() !== receipt.tree) return null;
  } catch { return null; }
  return receipt;
}

/**
 * Evaluate recorded evidence without running tests, writing receipts, or changing hook policy. The caller supplies
 * authoritative, append-ordered audit identities and explicit failure-to-item links; diagnostics are not evidence.
 * This evaluator deliberately cannot activate the replacement pre-push gate or stamp a smoke run as a full gate.
 */
export function pushReceiptProblems(root, { commits, landingReceipts, audits, filings, items, landingCommand, auditCommand }, receiptPorts) {
  const problems = [];
  for (const commit of commits) {
    const covered = landingReceipts.some(entry => entry.commit === commit
      && exactReceipt(root, entry.receiptId, landingCommand, commit, 'land', receiptPorts)?.green === true);
    if (!covered) problems.push(`commit ${commit} lacks its exact green landing receipt; land and record its gate before pushing`);
  }
  const latest = audits.at(-1);
  const audit = latest && exactReceipt(root, latest.receiptId, auditCommand, undefined, latest.kind ?? 'gate', receiptPorts);
  if (!audit) {
    problems.push('the latest full audit has no bound receipt; restore its evidence before pushing');
  } else if (!audit.green) {
    if (!audit.failures.length) problems.push('the latest audit is red without identified failures; inspect and file its unresolved failure before pushing');
    for (const failure of audit.failures) {
      const filed = filings.some(entry => entry.receiptId === audit.id && entry.file === failure.file && entry.name === failure.name
        && items.some(item => item.item_id === entry.item && ['open', 'claimed', 'submitted'].includes(item.item_status)));
      if (!filed) problems.push(`latest audit failure ${failure.file} :: ${failure.name} has no linked open repair item; file it before pushing`);
    }
  }
  return problems;
}
