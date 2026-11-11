/** A source advance executes the real raw affected closure, never placement deferral [C7,V4]. */
import { createHash } from 'node:crypto';
import { selectRegistryGuards } from '../../../../kernel/index.js';
import { mappedCheck } from '../../logic/path/map.js';
import { git } from '../../../../git/index.js';

/** Quote one literal repository file without shell interpretation. */
function word(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** Hash complete canonical source/selection facts, including the actual executed commands. */
export function sourceAdvanceHash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Compute the same nondeferred commands at origin and immediately before actual execution. */
export function sourceAdvancePlan(root, config, { base, changed, check }, selectors) {
  if (typeof selectors?.selectAffectedTests !== 'function' || typeof selectors?.selectTestTreeGuards !== 'function') throw new TypeError('source advance planning needs explicit test selector operations');
  const { selectAffectedTests, selectTestTreeGuards } = selectors;
  let selection = config.affectedTests ? selectAffectedTests(root, { base, changed })
    : { full: true, reason: 'affected-test selection is not enabled', files: [] };
  if (!selection.full && !selection.files.length) selection = { ...selection, full: true, reason: 'an empty affected closure requires the full gate for source advance' };
  const registryGuards = [...new Set([...selectRegistryGuards(root, config.registryGuards, { base, changed, git }),
    ...selectTestTreeGuards(root, { base, changed })])].sort();
  const invariants = [...new Set(config.submitInvariants ?? [])].sort();
  const proofFiles = [...new Set([...selection.files, ...invariants, ...registryGuards])].sort();
  const guardCommand = registryGuards.length ? `${config.affectedTests.trimEnd()} ${registryGuards.map(path => word('./' + path)).join(' ')}` : '';
  const criterion = check ? mappedCheck(root, check) : '';
  const affected = selection.full ? guardCommand ? `(${config.gate}) && ${guardCommand}` : config.gate
    : `${config.affectedTests.trimEnd()} ${proofFiles.map(path => word('./' + path)).join(' ')}`;
  const selectionDigest = sourceAdvanceHash(JSON.stringify({ base, changed: [...changed].sort(), full: selection.full,
    files: proofFiles, criterion, affected }));
  return { selection, registryGuards, invariants, proofFiles, criterion, affected, selectionDigest };
}
