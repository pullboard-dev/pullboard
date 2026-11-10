/** Audit-time placement construction and bounded change-time gate projection [C7]. */
import { createHash } from 'node:crypto';
import {
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  indexedStageSelection,
  readPlacementIndex,
} from './economics/placement.js';
import {
  gateStages,
} from '../stages.js';
import {
  literalShellWords,
} from '../../../../kernel/index.js';

/** A derived subset must never read or write the full-gate green stamp. */
export const VALUE_GATE = Symbol('value-selected-gate');

/** Quote a single literal argument, never a shell expression. */
export function testWord(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** No valid published inventory preserves the old gate; a valid index reads only reached rows. */
export function paidTests(root, files, stage, changed = []) {
  const index = readPlacementIndex(root, files);
  if (!index.generation) return null;
  return indexedStageSelection(root, files, stage, changed);
}

/** Published unknown reach belongs to audit; absent inventory retains the original full-gate safety fallback. */
export function placementSubmitSelection(root, selection, changed = []) {
  const paid = paidTests(root, selection.full ? [] : selection.files, 'submit', changed);
  return paid === null ? selection : { ...selection, full: false, files: paid,
    reason: selection.full ? `unknown reach deferred to audit: ${selection.reason}` : selection.reason };
}

/**
 * Replace recognized whole Node test stages, preserving all other configured commands and operators.
 * Opaque shell, filtered test commands and recursive npm scripts retain the original full gate.
 */
export function valueGateCommand(root, command, files, seen = new Set()) {
  const stages = gateStages(command);
  if (!stages || stages.some(stage => stage.pipeline.length !== 1 || stage.groupStart || stage.groupEnd || stage.op && stage.op !== '&&')) return null;
  let found = false;
  const output = [];
  for (const stage of stages) {
    const words = literalShellWords(stage.text);
    if (!words) return null;
    const node = /(?:^|\/)node(?:\.exe)?$/u.test(words[0]);
    const runner = node && (words[1] === '--test' || /(?:^|\/)(?:bin\/run-tests|packages\/gate\/src\/io\/run\/tests)\.js$/u.test(words[1] ?? ''));
    let next = stage.text;
    if (runner) {
      // A pre-existing selector/filter is a separate obligation, never expanded or weakened.
      if (words.length !== 2) return null;
      next = files.length ? `${words.map(testWord).join(' ')} ${files.map(testWord).join(' ')}` : 'true';
      found = true;
    } else if (words[0] === 'npm' && (words[1] === 'test' && words.length === 2 || words[1] === 'run' && words.length === 3)) {
      const name = words[1] === 'test' ? 'test' : words[2];
      if (seen.has(name)) return null;
      let script;
      try { script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.[name]; }
      catch { return null; }
      if (typeof script !== 'string') return null;
      const rewritten = valueGateCommand(root, script, files, new Set([...seen, name]));
      if (!rewritten) return null;
      next = rewritten;
      found = true;
    }
    output.push(next + (stage.op ? ` ${stage.op}` : ''));
  }
  return found ? output.join('\n') : null;
}

/** Project a landing's affected paid tests; explicit configured invariant/registry obligations remain. */
export function placementLandingGate(root, config, selection, mandatory = [], changed = []) {
  const paid = paidTests(root, selection.full ? [] : selection.files, 'landing', changed);
  if (paid === null) return null;
  const files = [...new Set([...paid, ...mandatory])].sort();
  const gate = valueGateCommand(root, config.gate, files);
  return gate === null ? null : { ...config, gate, [VALUE_GATE]: true };
}

/** Retain the exact selected file floor and plan digest without turning a selected gate into full-suite proof. */
export function placementLandingPlan(root, config, selection, mandatory = [], changed = []) {
  const projected = placementLandingGate(root, config, selection, mandatory, changed);
  if (!projected) return null;
  const files = [...new Set([...paidTests(root, selection.full ? [] : selection.files, 'landing', changed), ...mandatory])].sort();
  return { config: projected, files, subset: true, affectedGate: createHash('sha256').update(projected.gate).digest('hex') };
}
