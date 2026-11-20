/** Tighten held doctrine counts on the exact composed landing tree, before its gate [D1,D3,B3,R3]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './shards.js';
import { join } from 'node:path';
import {
  doctrineFile,
} from '../../../config/index.js';
import {
  checkRulesAt,
  runRuleCheck,
} from '../../../doctrine/index.js';
import { checkNeedsBrowser } from '../../../gate/heavy.js';
import { withGateSlot } from '../../../gate/heavy.js';
import { gateSlotEnvironment } from '../../../resources/index.js';
import {
  git,
  headCommit,
  isClean,
  untracked,
} from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { parseSpec } from '../../../spec/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** The held submit rules of the doctrine at HEAD: the ones whose counts a landing tightens. */
export function heldRules(root, config) {
  return checkRulesAt(root, 'HEAD', config.practice).filter(rule => rule.runs === 'submit' && rule.mode === 'hold');
}

/**
 * Count every held rule in this checkout, without touching it. Why: a runner job measures the derived tree so the coordinator spends no CPU on it [C7,#5583].
 * @returns {{ id: string, count: number, found: number, broken: string|null }[]|null} One row per rule, or null when a rule needs a browser (the caller measures where one is leased)
 */
export async function measureHeldRules(root, config) {
  const rules = heldRules(root, config);
  if ((await Promise.all(rules.map(rule => checkNeedsBrowser(root, rule.command)))).some(Boolean)) return null;
  return rules.map(rule => {
    const report = runRuleCheck(root, rule.command, config.check?.timeoutMs);
    return { id: rule.id, count: rule.count, found: report.problems.length, broken: report.broken ?? null };
  });
}

/**
 * Count held submit rules, refuse increases atomically, and commit only measured lower count fields.
 * `measured` carries rows a runner already counted on this exact tree; without it the rules run here.
 */
export async function tightenLandingDoctrine(root, config, { onWait, measured } = {}) {
  const rules = heldRules(root, config);
  if (!rules.length) return [];
  const head = headCommit(root);
  if ((!isClean(root) || untracked(root).length)) throw new Refused('LAND_DIRTY', 'the merged landing tree changed before its doctrine counts were measured');
  let reports = measured?.length === rules.length && rules.every(rule => measured.some(row => row.id === rule.id && row.count === rule.count)) ? measured : null;
  if (!reports) {
    const browser = (await Promise.all(rules.map(rule => checkNeedsBrowser(root, rule.command)))).some(Boolean);
    // Counts describe this exact merged checkout. A remote immutable checkout cannot carry its derived edits.
    reports = await withGateSlot(root, lease => rules.map(rule => {
      const report = runRuleCheck(root, rule.command, config.check?.timeoutMs, gateSlotEnvironment(lease));
      return { id: rule.id, count: rule.count, found: report.problems.length, broken: report.broken ?? null };
    }), { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, remote: false, agent: 'coordinator', kind: 'landing', item: 'landing doctrine', onWait });
  }
  if (headCommit(root) !== head || (!isClean(root) || untracked(root).length)) throw new Refused('LAND_DIRTY', 'a doctrine check changed the merged landing tree; inspect it before adopting');
  const uncounted = reports.filter(report => report.broken);
  if (uncounted.length) throw new Refused('RATCHET_UNCOUNTED', uncounted.map(report => `${report.id} cannot count: ${report.broken}`).join('\n'));
  const risen = reports.filter(report => report.found > report.count);
  if (risen.length) throw new Refused('RATCHET_ROSE', risen.map(report =>
    `${report.id} rose to ${report.found}, was ${report.count}; only the person's signature raises a count`).join('\n'));
  const lowered = reports.filter(report => report.found < report.count)
    .map(report => ({ id: report.id, before: report.count, count: report.found }));
  if (!lowered.length) return [];
  const file = doctrineFile(root, config.practice);
  const source = fs.readFile(join(root, file), 'utf8');
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
  fs.writeFile(join(root, file), lines.join('\n'));
  git(root, ['add', '--', file]);
  git(root, ['commit', '-m', 'chore(doctrine): record lower held counts']);
  return lowered;
}
