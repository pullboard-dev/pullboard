/** Tighten held doctrine counts on the exact composed landing tree, before its gate [D1,D3,B3,R3]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './shards.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  doctrineFile,
} from '../../../config/index.js';
import {
  checkRulesAt,
  runRuleCheck,
} from '../../../doctrine/index.js';
import { checkNeedsBrowser } from '../../../gate/index.js';
import { withGateSlot } from '../../../gate/index.js';
import { gateSlotEnvironment } from '../../../resources/index.js';
import {
  git,
  headCommit,
  isClean,
  untracked,
} from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { parseSpec } from '../../../spec/index.js';

/** Count held submit rules, refuse increases atomically, and commit only measured lower count fields. */
export async function tightenLandingDoctrine(root, config, { onWait } = {}) {
  const rules = checkRulesAt(root, 'HEAD', config.practice).filter(rule => rule.runs === 'submit' && rule.mode === 'hold');
  if (!rules.length) return [];
  const head = headCommit(root);
  if ((!isClean(root) || untracked(root).length)) throw new Refused('LAND_DIRTY', 'the merged landing tree changed before its doctrine counts were measured');
  const browser = (await Promise.all(rules.map(rule => checkNeedsBrowser(root, rule.command)))).some(Boolean);
  // Counts describe this exact merged checkout. A remote immutable checkout cannot carry its derived edits.
  const reports = await withGateSlot(root, lease => rules.map(rule => ({ rule,
    ...runRuleCheck(root, rule.command, config.check?.timeoutMs, gateSlotEnvironment(lease)) })),
  { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, remote: false, agent: 'coordinator', kind: 'doctrine', onWait });
  if (headCommit(root) !== head || (!isClean(root) || untracked(root).length)) throw new Refused('LAND_DIRTY', 'a doctrine check changed the merged landing tree; inspect it before adopting');
  const uncounted = reports.filter(report => report.broken);
  if (uncounted.length) throw new Refused('RATCHET_UNCOUNTED', uncounted.map(report => `${report.rule.id} cannot count: ${report.broken}`).join('\n'));
  const risen = reports.filter(report => report.problems.length > report.rule.count);
  if (risen.length) throw new Refused('RATCHET_ROSE', risen.map(report =>
    `${report.rule.id} rose to ${report.problems.length}, was ${report.rule.count}; only the person's signature raises a count`).join('\n'));
  const lowered = reports.filter(report => report.problems.length < report.rule.count)
    .map(report => ({ id: report.rule.id, before: report.rule.count, count: report.problems.length }));
  if (!lowered.length) return [];
  const file = doctrineFile(root, config.practice);
  const source = readFileSync(join(root, file), 'utf8');
  const rows = parseSpec(source, { strictGrammarVersion: false }).rows;
  const lines = source.split('\n');
  for (const change of lowered) {
    const row = rows.find(candidate => candidate.id === change.id);
    if (!row || Number(row.count) !== change.before) throw new Refused('LAND_DIRTY', `the committed count for ${change.id} changed while its landing was measured`);
    const previous = lines[row.line - 1];
    const next = previous.replace(/(\|\s*count:\s*)\d+(?=\s*(?:\||$))/u, (_, prefix) => prefix + change.count);
    if (next === previous) throw new Refused('LAND_DIRTY', `the measured count field for ${change.id} could not be tightened`);
    lines[row.line - 1] = next;
  }
  writeFileSync(join(root, file), lines.join('\n'));
  git(root, ['add', '--', file]);
  git(root, ['commit', '-m', 'chore(doctrine): record lower held counts']);
  return lowered;
}
