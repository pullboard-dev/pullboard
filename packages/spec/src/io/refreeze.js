/** Deterministic, receiver-safe payloads for items affected by an approved spec-row correction [V2,H16]. */
import { createHash } from 'node:crypto';
import { parseSpec } from './main.js';
import { rowDecisions } from '../logic/row/draft.js';
import { Refused } from '../../../kernel/index.js';

/** Parse the exact source and replacement captured in one approved person decision. */
function approvedRowChange(record) {
  if (record.kind !== 'spec' || record.decision !== 'approve') return null;
  const before = parseSpec(`## Decision\n${record.source}\n`).rows;
  const after = parseSpec(`## Decision\n${record.replacement}\n`).rows;
  if (before.length !== 1 || after.length !== 1 || before[0].id !== record.id || after[0].id !== record.id
    || after[0].status !== 'approved' || (before[0].status === after[0].status
      && before[0].text === after[0].text && before[0].gate === after[0].gate)) return null;
  return { id: record.id, status: after[0].status, text: after[0].text, gate: after[0].gate };
}

/** Return the approved spec rows whose frozen text or gate actually changed. */
function changedRows(records) {
  const changed = new Map();
  for (const record of records) {
    const row = approvedRowChange(record);
    if (row) changed.set(row.id, row);
  }
  return changed;
}

/** Require the correction protocol for every semantic approved-row change, even without citations. */
export function needsSpecRefreezes(records) {
  return changedRows(records).size > 0;
}

/** Snapshot state that must remain unchanged between local payload preparation and relay replay. */
function itemSnapshot(item) {
  return {
    status: item.item_status,
    owner: item.item_owner ?? null,
    leaseUntil: item.item_lease_until ?? null,
    frozenDigest: item.item_frozen_digest ?? null,
    commit: item.item_commit ?? null,
    mergedCommit: item.item_merged_commit ?? null,
    verdict: item.item_verdict ?? null,
  };
}

/** Find every still-unmerged item that cites at least one changed spec row. */
function affectedItems(items, rows) {
  return items.filter(item => item.item_status !== 'withdrawn' && !item.item_merged_commit
    && (item.item_spec_ids ?? '').split(',').some(id => rows.has(id)))
    .sort((left, right) => left.item_id - right.item_id);
}

/** Derive draft omissions from native decisions and lifetime freeze history, never sender assertions. */
export function specRefreezeSkips(board, records, items) {
  const declined = new Set();
  for (const record of rowDecisions(board)) {
    if (record.kind !== 'spec' || record.decision !== 'decline') continue;
    const before = parseSpec(`## Decision\n${record.source}\n`).rows[0];
    const after = parseSpec(`## Decision\n${record.replacement}\n`).rows[0];
    if (before?.id === record.id && after?.id === record.id
      && ['draft', 'pending'].includes(before.status) && after.status === 'wont') declined.add(record.id);
  }
  const frozenBefore = board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind IN ('claim','refreeze','submit') LIMIT 1");
  return affectedItems(items, changedRows(records)).filter(item => item.item_status === 'open'
    && !item.item_frozen && !item.item_frozen_digest && !item.item_commit && !item.item_verdict
    && (item.item_spec_ids ?? '').split(',').some(id => declined.has(id))
    && !frozenBefore.get(item.item_id)).map(item => item.item_id);
}

/** Protect an approved cited promise; unapproved blueprint drafts may still be declined by the person. */
export function assertNoCitedSpecDecline(records, items) {
  const active = items.filter(item => item.item_status !== 'withdrawn' && !item.item_merged_commit);
  for (const record of records) {
    if (record.kind !== 'spec' || record.decision !== 'decline') continue;
    const before = parseSpec(`## Decision\n${record.source}\n`).rows[0];
    const after = parseSpec(`## Decision\n${record.replacement}\n`).rows[0];
    if (!before || !after || before.id !== record.id || after.id !== record.id || before.status !== 'approved') continue;
    if (active.some(item => (item.item_spec_ids ?? '').split(',').includes(record.id))) {
      throw new Refused('ROW_DECISION', `${record.id} is cited by unmerged work; approve a replacement or withdraw the citing items before declining it`);
    }
  }
}

/** Build complete frozen payloads from the already-written, locally preflighted spec file. */
export function prepareSpecRefreezes(records, items, freeze, { skippedDrafts = [] } = {}) {
  const rows = changedRows(records);
  if (!rows.size) return undefined;
  if (typeof freeze !== 'function' || !Array.isArray(items)) throw new TypeError('spec refreezes need current items and a local freezer');
  return affectedItems(items, rows).filter(item => !skippedDrafts.includes(item.item_id)).map(item => {
    const ids = (item.item_spec_ids ?? '').split(',').filter(Boolean);
    const changedIds = ids.filter(id => rows.has(id));
    let prior = null;
    if (item.item_frozen) {
      try { prior = JSON.parse(item.item_frozen); }
      catch { throw new Refused('ROW_DECISION', `item #${item.item_id} has an invalid prior frozen payload; repair the item before applying the spec correction`); }
    }
    const source = prior ? { ...item, item_spec_ids: changedIds.join(',') } : item;
    let frozen = freeze(source);
    if (!frozen || typeof frozen.text !== 'string' || typeof frozen.digest !== 'string'
      || createHash('sha256').update(frozen.text).digest('hex') !== frozen.digest) {
      throw new Refused('ROW_DECISION', `could not prepare a complete frozen criterion for #${item.item_id}; restore the spec file and retry spec apply`);
    }
    if (prior) {
      let current;
      try { current = JSON.parse(frozen.text); }
      catch { throw new Refused('ROW_DECISION', `could not prepare a complete frozen criterion for #${item.item_id}; restore the spec file and retry spec apply`); }
      if (!current || typeof current !== 'object' || Array.isArray(current) || !Array.isArray(current.rows)) {
        throw new Refused('ROW_DECISION', `could not prepare a complete frozen criterion for #${item.item_id}; restore the spec file and retry spec apply`);
      }
      const previousRows = new Map((Array.isArray(prior.rows) ? prior.rows : []).map(row => [row?.id, row]));
      const currentRows = new Map((Array.isArray(current?.rows) ? current.rows : []).map(row => [row?.id, row]));
      const mergedRows = ids.map(id => rows.has(id) ? currentRows.get(id) : previousRows.get(id));
      if (mergedRows.some(row => !row || typeof row.id !== 'string' || typeof row.text !== 'string' || typeof row.gate !== 'string')) {
        throw new Refused('ROW_DECISION', `item #${item.item_id} has an incomplete prior frozen payload; repair the item before applying the spec correction`);
      }
      const text = JSON.stringify({ ...current, rows: mergedRows });
      frozen = { text, digest: createHash('sha256').update(text).digest('hex') };
    }
    return { itemId: item.item_id, before: itemSnapshot(item), frozen };
  });
}

/** Prepare the complete current apply payload from one already-held native board write snapshot. */
export function prepareSpecRowApplyPayload(board, events, freeze) {
  if (!Array.isArray(events) || events.some(event => !Number.isSafeInteger(event) || event < 1)
    || new Set(events).size !== events.length) {
    throw new Refused('ROW_DECISION', 'apply needs current decision event ids; use pullboard spec apply');
  }
  const decisions = rowDecisions(board);
  const records = events.map(event => decisions.find(record => record.event === event && !record.applied));
  if (records.some(record => !record)) throw new Refused('STALE_ROW_DECISION', 'a row decision was replaced; use pullboard spec apply with the current decisions');
  const items = board.db.prepare('SELECT * FROM item ORDER BY item_id').all();
  const skippedDrafts = specRefreezeSkips(board, records, items);
  const refreezes = prepareSpecRefreezes(records, items, freeze, { skippedDrafts });
  return { records, items, skippedDrafts, ...(refreezes === undefined ? {} : { refreezes }) };
}

/** Validate a correction payload using only SQLite and sealed decision bytes; receivers never read Git or files. */
export function validateSpecRefreezes(board, events, refreezes, { skippedDrafts } = {}) {
  if (!Array.isArray(refreezes)) throw new Refused('ROW_DECISION', 'the spec correction payload is invalid; run pullboard spec apply again');
  const eventSet = new Set(events);
  const records = rowDecisions(board).filter(record => eventSet.has(record.event) && !record.applied);
  const rows = changedRows(records);
  if (!rows.size) throw new Refused('STALE_ROW_DECISION', 'the spec correction no longer changes an approved row; run pullboard spec apply again');
  const allItems = board.db.prepare('SELECT * FROM item ORDER BY item_id').all();
  if (skippedDrafts !== undefined) {
    const expectedSkips = specRefreezeSkips(board, records, allItems);
    if (!Array.isArray(skippedDrafts) || !skippedDrafts.length
      || JSON.stringify(skippedDrafts) !== JSON.stringify(expectedSkips)) {
      throw new Refused('STALE_ROW_DECISION', 'the explicitly declined draft citations changed; run pullboard spec apply again');
    }
  }
  const expected = affectedItems(allItems, rows).filter(item => !skippedDrafts?.includes(item.item_id));
  if (expected.length !== refreezes.length || expected.some((item, index) => item.item_id !== refreezes[index]?.itemId)) {
    throw new Refused('STALE_ROW_DECISION', 'the set of cited items changed while applying this spec correction; run pullboard spec apply again');
  }
  return refreezes.map((entry, index) => {
    const item = expected[index];
    const keys = Object.keys(entry ?? {}).sort();
    const before = itemSnapshot(item);
    if (keys.join(',') !== 'before,frozen,itemId' || !entry.before || typeof entry.before !== 'object'
      || Object.keys(entry.before).sort().join(',') !== Object.keys(before).sort().join(',')
      || Object.entries(before).some(([key, value]) => entry.before[key] !== value)) {
      throw new Refused('STALE_ROW_DECISION', `item #${item.item_id} changed while applying this spec correction; run pullboard spec apply again`);
    }
    const frozen = entry.frozen;
    if (!frozen || Object.keys(frozen).sort().join(',') !== 'digest,text' || typeof frozen.text !== 'string'
      || !/^[a-f0-9]{64}$/u.test(frozen.digest ?? '')
      || createHash('sha256').update(frozen.text).digest('hex') !== frozen.digest) {
      throw new Refused('ROW_DECISION', `item #${item.item_id} has an invalid frozen payload; run pullboard spec apply again`);
    }
    let criterion;
    try { criterion = JSON.parse(frozen.text); }
    catch { throw new Refused('ROW_DECISION', `item #${item.item_id} has an invalid frozen payload; run pullboard spec apply again`); }
    const citationIds = (item.item_spec_ids ?? '').split(',').filter(Boolean);
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)
      || criterion.title !== item.item_title || criterion.criterion !== item.item_criterion
      || (criterion.sourceCheck ?? criterion.check ?? '') !== (item.item_check ?? '')
      || !Array.isArray(criterion.rows) || criterion.rows.length !== citationIds.length
      || criterion.rows.some((row, rowIndex) => row?.id !== citationIds[rowIndex])) {
      throw new Refused('ROW_DECISION', `item #${item.item_id} has an incomplete frozen payload; run pullboard spec apply again`);
    }
    for (const row of criterion.rows) {
      const corrected = rows.get(row.id);
      if (corrected && (row.text !== corrected.text || row.gate !== corrected.gate)) {
        throw new Refused('ROW_DECISION', `item #${item.item_id} does not freeze the approved ${row.id} text; run pullboard spec apply again`);
      }
    }
    if (item.item_frozen) {
      let previous;
      try { previous = JSON.parse(item.item_frozen); }
      catch { throw new Refused('STALE_ROW_DECISION', `item #${item.item_id} has an invalid prior frozen criterion; repair the item before applying the spec correction`); }
      for (const row of criterion.rows) {
        if (rows.has(row.id)) continue;
        const old = previous.rows?.find(candidate => candidate.id === row.id);
        if (!old || old.text !== row.text || old.gate !== row.gate) {
          throw new Refused('ROW_DECISION', `item #${item.item_id} changed an unrelated frozen ${row.id} row; run pullboard spec apply again`);
        }
      }
    }
    return { item, frozen };
  });
}
