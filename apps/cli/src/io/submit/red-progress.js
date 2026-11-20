/** The red-loop guard of a submit and the head restore after a busy board, which the pulled submit path still runs [C7,#6096,#6489]. */
import { createHash } from 'node:crypto';
import { cachedMainComparison } from '../../../../../packages/landing/index.js';
import {
  cleanGitEnvironment,
  contains,
  gitSpawnSync,
  headCommit,
  isClean,
  tryGit,
} from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { redsAreMains } from './reds.js';

/** Hash the candidate's net code diff against the same admitted main used for every red head. */
function itemChangeHash(root, head, main) {
  const base = tryGit(root, ['merge-base', head, main]);
  if (base.status !== 0 || !base.stdout) throw new Refused('NO_POLICY', 'the item or admitted main history cannot be read; restore Git history before submitting again');
  const diff = gitSpawnSync(['--no-replace-objects', '-c', 'core.quotepath=false', 'diff', '--binary', '--no-ext-diff', base.stdout, head], {
    cwd: root, env: cleanGitEnvironment(), maxBuffer: 32 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Refused('NO_POLICY', 'the item net diff cannot be read; restore Git history before submitting again');
  return createHash('sha256').update(diff.stdout).digest('hex');
}

/** Project red handoffs only when their same-run native receipt proves this item's test failed. */
function redSubmitTestRuns(board, id, digest, root) {
  const rows = board.db.prepare("SELECT event_id,event_by,event_kind,event_detail FROM event WHERE item_id=? AND event_kind IN ('submit-handoff','proof-run') ORDER BY event_id").all(id);
  const red = [];
  let running = null;
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.event_detail); } catch { running = null; continue; }
    if (row.event_kind === 'submit-handoff') {
      if (detail.state === 'running') running = { actor: row.event_by, source: detail.commit, receipts: [] };
      else if (detail.state === 'red') {
        if (running?.actor === row.event_by && running.source === detail.commit) {
          const receipts = running.receipts.filter(receipt => receipt.kind === 'submit' && receipt.item === id
            && receipt.seat === row.event_by && receipt.frozenDigest === digest && receipt.sourceClean === true
            && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode !== 0 && receipt.counts?.failed > 0
            && contains(root, detail.commit, receipt.commit));
          const commits = [...new Set(receipts.map(receipt => receipt.commit))];
          if (commits.length === 1) red.push({ eventId: row.event_id, commit: commits[0], failures: receipts.flatMap(receipt => receipt.failures ?? []) });
        }
        running = null;
      } else running = null;
    } else if (running && detail.receipt) {
      const receipt = detail.receipt;
      if (receipt.item === id && receipt.seat === row.event_by && receipt.frozenDigest === digest) running.receipts.push(receipt);
    }
  }
  return red;
}

/**
 * Every live item's latest red gate failures, for the Main red ledger to tell the items a fixed red blocked [C7,#1269].
 * Why: this file already projects a gate's red handoffs with their failing file and case rows; the ledger reads the same rows rather than a second reading.
 *
 * @param {object} board
 * @param {string} root
 * @returns {{ id: number, failures: { file: string, name: string }[] }[]} One row per open, claimed or submitted item that has a red gate.
 */
export function openItemReds(board, root) {
  const rows = board.db.prepare("SELECT item_id AS id, item_frozen_digest AS digest FROM item WHERE item_status IN ('open','claimed','submitted') AND item_merged_commit IS NULL").all();
  const reds = [];
  for (const { id, digest } of rows) {
    const latest = redSubmitTestRuns(board, id, digest, root).at(-1);
    if (latest) reds.push({ id, failures: latest.failures });
  }
  return reds;
}

/** Whether the local cache records main failing every case of a red gate, by file and case name. */
function knownMainReds(root, failures, main) {
  if (!failures?.length) return false;
  try { return redsAreMains(failures, cachedMainComparison(root, main, failures.map(row => row.file)), main); } catch { return false; }
}

/** Stop unchanged third red submissions, queued or pulled, while naming the two test failures that need repair. */
export function requireRedSubmitProgress(root, board, id, digest, candidate, main, pulledReds = () => []) {
  // A gate whose every red is a case main fails by the same name is main's red, not the item's code, so it is no loop [C7].
  const red = [...redSubmitTestRuns(board, id, digest, root), ...pulledReds(board, id)].sort((a, b) => a.eventId - b.eventId).filter(row => !knownMainReds(root, row.failures, main));
  if (red.length < 2) return;
  const latest = red.slice(-2);
  // A pulled gate writes its own notes and red facts; only a fact that is not the gate's own counts as the holder's progress.
  const latestFact = board.db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=? AND event_kind='fact' AND COALESCE(json_extract(event_detail,'$.text'),'') NOT LIKE 'Gate job %'").get(id).id;
  if (latestFact > latest.at(-1).eventId) return;
  const candidateHash = itemChangeHash(root, candidate, main);
  const hashes = latest.map(row => itemChangeHash(root, row.commit, main));
  if (hashes.every(hash => hash !== candidateHash)) return;
  const named = latest.map(row => {
    const failure = row.failures.find(value => value.file || value.name);
    const name = failure ? `${failure.file ?? ''}${failure.file ? ':' : ''}${failure.name ?? ''}`.trim() : 'test failure';
    return `${name.slice(0, 120)} at ${row.commit.slice(0, 12)}`;
  }).join(' and ');
  throw new Refused('SUBMIT_RED_LOOP', `two red test gates still match this item code (${named}); change the failing code before another submit`,
    `fix the two red test failures: ${named}; then commit the code change and submit again`);
}

/**
 * Put the item folder back on its pre-submit head after a BOARD_BUSY refusal that followed the automatic main merge.
 * Why: the refusal records nothing, so a moved head only strands the clause evidence ticked at the old head [#6096].
 * Only a clean tree whose head is exactly that merge (first parent the old head) is reset; any other state is left alone.
 */
export function restoreMergedHead(root, before) {
  if (!before) return;
  const now = headCommit(root);
  if (!now || now === before || !isClean(root)) return;
  const parents = tryGit(root, ['show', '-s', '--format=%P', now]);
  if (parents.status !== 0 || parents.stdout.trim().split(' ')[0] !== before || parents.stdout.trim().split(' ').length !== 2) return;
  tryGit(root, ['reset', '--hard', '-q', before]);
}
