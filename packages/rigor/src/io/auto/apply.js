/** Explicitly materialize board proposals before the existing person-only exact-row decision [D1,S1]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDoctrine } from '../../../../doctrine/index.js';
import {
  loadSpec,
  insertSectionRows,
} from '../../../../spec/index.js';
import { Refused } from '../../../../kernel/index.js';
import {
  automaticDecisionSource,
  automaticSourceFromText,
  sameAutomaticRow,
} from '../../../../store/index.js';
import {
  rowDecisionContext,
  staleRowDecision,
} from '../../../../spec/index.js';

/** Where the layout move recorded each old path and the path it became, tab separated. */
const RENAMES = 'packages/codemap/data/plan/renames.tsv';

/** Rewrite old paths in a draft's prose to their renamed paths; the typed source tail is never touched. */
function renameDraftText(root, text) {
  const file = join(root, RENAMES);
  if (!existsSync(file)) return text;
  const map = new Map(readFileSync(file, 'utf8').split('\n').map(line => line.split('\t'))
    .filter(([from, to]) => from && to && from !== to && text.includes(from)));
  if (!map.size) return text;
  const tail = text.search(/(?:^| )Source: rigor-auto:\S+$/u);
  const prose = tail < 0 ? text : text.slice(0, tail), source = tail < 0 ? '' : text.slice(tail);
  const olds = [...map.keys()].sort((a, b) => b.length - a.length).map(old => old.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const found = new RegExp(`(?<![\\w./-])(?:${olds.join('|')})(?![\\w/-]|\\.\\w)`, 'gu');
  return prose.replace(found, old => map.get(old)) + source;
}

/** A file row is the same draft when only the layout move's path renames separate their text. */
function sameRenamedRow(root, row, draft) {
  const text = renameDraftText(root, draft.text);
  return text !== draft.text && sameAutomaticRow(row, { ...draft, text });
}

/** Preflight every definition and both id namespaces before returning even the first file write. */
export function planAutomaticRigorApply(root, config, drafts, decisions = []) {
  const spec = loadSpec(root, config);
  const doctrine = loadDoctrine(root, config);
  const parsed = new Map([['spec', { ...spec, name: config.spec }], ['doctrine', { ...doctrine.repo, name: doctrine.name }]]);
  const pending = drafts.filter(draft => !draft.written && automaticSourceFromText(draft.text));
  if (!pending.length) return { records: [], files: [], signoffs: { receipts: [] } };
  const all = [...spec.rows.map(row => ({ ...row, target: 'spec' })), ...doctrine.repo.rows.map(row => ({ ...row, target: 'doctrine' }))];
  const byTarget = new Map();
  const decisionContext = rowDecisionContext(root, config);
  for (const draft of pending) {
    const file = parsed.get(draft.target);
    if (!file?.exists || file.problems.length) throw new Refused('ROW_DRAFT', `restore readable ${file?.name ?? draft.target} before materializing Rigor proposals`);
    const found = all.filter(row => row.id === draft.id);
    const decided = decisions.findLast(record => record.kind === draft.target && record.id === draft.id
      && automaticDecisionSource(record) === automaticSourceFromText(draft.text));
    // A person's exact replacement may deliberately change or remove the proposal source text.
    if (decided && found.length === 1 && found[0].target === draft.target && !staleRowDecision(decided, decisionContext)) continue;
    if (found.length) {
      if (found.length === 1 && found[0].target === draft.target && (sameAutomaticRow(found[0], draft) || sameRenamedRow(root, found[0], draft))) continue;
      throw new Refused('ROW_DRAFT', `${draft.id} already names different ${found.map(row => row.target).join('/')} text, gate or tier; resolve the collision before applying any automatic Rigor draft`);
    }
    if (!byTarget.has(draft.target)) byTarget.set(draft.target, []);
    byTarget.get(draft.target).push(draft);
    all.push(draft);
  }
  const files = [...byTarget].map(([target, entries]) => {
    const file = parsed.get(target);
    const before = readFileSync(file.file, 'utf8');
    const lines = entries.map(draft => `- ${draft.id} [draft, ${draft.tier}] ${draft.text} | gate: ${draft.gate}`);
    const section = file.sections.find(entry => /^RG\s*[·.:-]/u.test(entry.name));
    const after = section ? insertSectionRows(before, file, section, lines)
      : `${before}${before.endsWith('\n') ? '' : '\n'}\n## RG · Rigor proposals\n${lines.join('\n')}\n`;
    return { file: file.name, before, after };
  });
  return { records: [], files, signoffs: { receipts: [] } };
}
