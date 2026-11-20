/** Validated coordinator run facts and immutable source interpretation live only in local proof projections [S1,R2,C7]. */
import { join } from 'node:path';
import { repoInfo } from '../../../../../git/index.js';
import { receiptFields } from '../../../logic/proof/provenance.js';
import {
  committedRuleCoverage,
  proofCoverageFingerprint,
} from './coverage.js';
import { fileSystemAdapter } from '../../../../../fs/index.js';

const fs = fileSystemAdapter();

/** Use the registered coordinator's repository only when it owns this exact board file. */
function sourceRoot(board) {
  const root = board.db.prepare("SELECT agent_path FROM agent WHERE agent_id='coordinator'").get()?.agent_path;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!root || !file) return null;
  try {
    return fs.realpath(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) === fs.realpath(file) ? root : null;
  } catch { return null; }
}

/** Fold one already-ordered native event; malformed/legacy receipts never gain proof by indexing. */
export function appendRuleProof(board, event, detail, get, put) {
  if (event.event_kind !== 'gate-run' || event.event_by !== 'coordinator') return;
  const run = receiptFields(detail.run);
  if (!run || run.head !== run.main) return;
  if (!run.green) {
    put(`rule-red:${event.event_id}`, { event: event.event_id, kind: run.kind, at: run.at,
      files: [...new Set(run.failures.map(failure => failure.file))] });
    return;
  }
  if (!['gate', 'land'].includes(run.kind)) return;
  const root = sourceRoot(board);
  if (!root) return;
  const fingerprint = proofCoverageFingerprint();
  const key = `rule-source:${run.head}:${fingerprint}:${encodeURIComponent(root)}:${encodeURIComponent(process.execPath)}`;
  let source = get(key);
  if (!source) {
    source = committedRuleCoverage(root, run.head);
    if (source) put(key, source);
  }
  if (!source || source.head !== run.head || source.tree !== run.tree || source.command !== run.command || source.fingerprint !== fingerprint) return;
  // Another writer may not recognize an absolute Node path; its opaque result cannot erase known coverage.
  if (!source.files.length) return;
  put(`rule-green:${run.head}:${fingerprint}`, { ...source, event: event.event_id });
}
