/** Live exact-row identity shared by approval listings and health [S1,B26]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doctrineFile } from '../../../../config/light.js';
import { loadConfig } from '../../../../config/light.js';
import { parseSpec } from '../main.js';

/** Read each current file once per projection; raw source stays private to this lookup. */
export function rowDecisionContext(root, config = loadConfig(root)) {
  const files = new Map();
  return (kind, id) => {
    const file = kind === 'spec' ? config.spec : doctrineFile(root, config.practice);
    if (!files.has(file)) {
      const path = join(root, file);
      const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
      files.set(file, { rows: parseSpec(source).rows, lines: source.split(/\r?\n/u) });
    }
    const { rows, lines } = files.get(file);
    const matches = rows.filter(row => row.id === id);
    return { file, count: matches.length, row: matches[0], source: matches.length === 1 ? lines[matches[0].line - 1] : undefined };
  };
}

/** Use the same exact file/source-or-replacement boundary as planRowApply, without applying it. */
export function staleRowDecision(record, context) {
  const current = context(record.kind, record.id);
  const aliases = new Set(['DOCTRINE.md', 'PRACTICE.md']);
  let changed;
  if (current.file !== record.file && !(record.kind === 'doctrine' && aliases.has(current.file) && aliases.has(record.file))) changed = ['file'];
  else if (current.count !== 1) changed = [current.count ? 'duplicate id' : 'missing row'];
  else if (current.source === record.source || current.source === record.replacement) return null;
  else {
    const before = parseSpec(`## Decision\n${record.source}\n`).rows[0];
    changed = before ? Object.keys(before).filter(key => !['line', 'section'].includes(key)
      && JSON.stringify(before[key]) !== JSON.stringify(current.row[key])) : [];
    if (!changed.length) changed = ['format'];
  }
  const why = `STALE: ${record.id}'s ${changed.join(', ')} changed after the person's decision`;
  const next = `ask the person to approve ${record.id}'s current row again`;
  return { code: 'STALE_ROW_DECISION', changed, why, next };
}

/** All blocked pending decisions, including removed rows that have no listing to decorate. */
export function staleRowDecisions(records, root, config) {
  const context = rowDecisionContext(root, config);
  return records.filter(record => !record.applied).flatMap(record => {
    const stale = staleRowDecision(record, context);
    return stale ? [{ ...stale, id: record.id, kind: record.kind, at: record.at ?? record.on }] : [];
  });
}
