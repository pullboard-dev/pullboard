/** Person approval guards staged approved-row rewrites and exposes stale frozen items [S19,V3]. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { parseSpec, SIGNOFFS_FILE } from './spec.js';
import { rowDecisions } from './board.js';
import { hasSignerFile, verifySignedRecords } from './signature.js';
import { Refused } from './refused.js';

const TRUST_FILES = ['.pullboard/signers', '.pullboard/first-commit', '.pullboard/signers.initial', SIGNOFFS_FILE];

/** Read exact Git object bytes rather than an unrelated unstaged working copy. */
function gitText(root, revision, file) {
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

/** Read the shared decision index without opening the board's migrator or changing its evidence. */
function boardApprovals(file) {
  if (!file || !existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return rowDecisions({ db }); }
  finally { db.close(); }
}

/** Verify staged receipts using staged trust files anchored to the already committed opt-in. */
function stagedApprovals(root, decisions) {
  const snapshot = mkdtempSync(join(tmpdir(), 'pullboard-staged-approval-'));
  try {
    mkdirSync(join(snapshot, '.pullboard'));
    for (const file of TRUST_FILES) {
      const staged = gitText(root, '', file);
      const before = gitText(root, 'HEAD', file);
      if (before !== null && (file.endsWith('/first-commit') || file.endsWith('/signers.initial')) && staged !== before) {
        throw new Refused('APPROVED_ROW_CHANGE', `${file} cannot change the established SSH trust anchor; restore its committed bytes`);
      }
      if (file.endsWith('/signers') && before !== null && staged === null) throw new Refused('APPROVED_ROW_CHANGE', 'SSH signers cannot be removed to bypass person approval; restore .pullboard/signers');
      if (staged !== null) writeFileSync(join(snapshot, file), staged);
    }
    const ledger = gitText(root, '', SIGNOFFS_FILE);
    const records = ledger?.split('\n').filter((line) => line.trim()).map(JSON.parse) ?? [];
    const signed = decisions.filter((record) => record.signature);
    verifySignedRecords(snapshot, [...records, ...signed]);
    const enabled = hasSignerFile(snapshot);
    return { records: enabled ? records.filter((record) => record.signature) : [], signed: enabled };
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}

/** Refuse each rewritten approved row unless its exact staged target has person authorization. */
export function approvedRowProblems(root, config, boardFile) {
  const changes = [];
  for (const [kind, file] of [['spec', config.spec], ['doctrine', config.practice]]) {
    const before = gitText(root, 'HEAD', file);
    const staged = gitText(root, '', file);
    if (before === null || staged === null || before === staged) continue;
    const rows = parseSpec(staged);
    for (const old of parseSpec(before).rows.filter((row) => row.status === 'approved')) {
      const matches = rows.rows.filter((row) => row.id === old.id);
      if (matches.length !== 1 || matches[0].text === old.text) continue;
      changes.push({ kind, file, row: matches[0], target: staged.split(/\r?\n/u)[matches[0].line - 1] });
    }
  }
  if (!changes.length) return [];
  try {
    const decisions = boardApprovals(boardFile);
    const trust = stagedApprovals(root, decisions);
    return changes.filter(({ kind, file, row, target }) => {
      const approved = decisions.some((record) => record.kind === kind && record.id === row.id && record.file === file
        && record.replacement === target && record.text === row.text && (!trust.signed || record.decision === 'decline' || record.signature));
      const signed = trust.records.some((record) => record.id === row.id && record.text === row.text
        && (record.type === 'row-decision' ? record.kind === kind && record.file === file : kind === 'spec'));
      return !approved && !signed;
    }).map(({ kind, file, row }) => `${file}: ${row.id} changes approved text without the person's exact approval; ask the person to approve ${kind === 'doctrine' ? 'doctrine:' : ''}${row.id} in pullboard view or sign its new text, then stage the signed receipt`);
  } catch (error) {
    return [`approved-row authorization cannot be checked: ${error.message}; restore valid staged SSH trust files and signed receipts before committing`];
  }
}

/** List every frozen item whose cited row text has changed, retaining historical accepted receipts. */
export function staleFrozenItems(items, rows) {
  const current = new Map(rows.map((row) => [row.id, row.text]));
  return items.flatMap((item) => {
    if (!item.item_frozen) return [];
    const frozen = JSON.parse(item.item_frozen);
    const changed = (frozen.rows ?? []).filter((row) => current.get(row.id) !== row.text).map((row) => row.id);
    return changed.length ? [{ id: item.item_id, lane: item.item_lane, status: item.item_status, merged: !!item.item_merged_commit, rows: changed }] : [];
  });
}

/** Explain repair without changing a historical verdict or pretending closed items can refreeze. */
export function staleItemFinding(item) {
  const rows = item.rows.join(', ');
  const active = ['open', 'claimed', 'submitted'].includes(item.status);
  const message = item.status === 'verified' || item.merged
    ? `item #${item.id} shipped against the old text of ${rows}`
    : `item #${item.id} (${item.status}) is stale: frozen against the old text of ${rows}`;
  const title = `Bring #${item.id} in line with ${rows}'s new text`;
  const quoted = `'${title.replaceAll("'", "'\\''")}'`;
  const next = active ? `ask the coordinator to run pullboard refreeze ${item.id}`
    : `ask the coordinator for a follow-up: pullboard add ${item.lane} ${quoted} --specs ${item.rows.join(',')}`;
  return { code: 'STALE_ITEM', message, next };
}
