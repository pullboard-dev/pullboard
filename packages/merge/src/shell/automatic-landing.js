import { readFileSync } from 'node:fs';
/** Acceptance owns mechanical landing; the existing engine retains batching, gates and rework [B35,B3,R3]. */
import { Refused } from '../../../kernel/index.js';
import { mechanicalConflictFiles } from './mechanical-merge.js';

/** Only policy already accepted on trunk can grant a manual landing override. */
export function automaticLandingEnabled(config) {
  return config.landing?.manualOverride !== true;
}

/** Refuse a coordinator command while the board owns landing. */
export function requireManualLanding(config) {
  if (automaticLandingEnabled(config)) throw new Refused('BOARD_LANDS_ACCEPTED', 'the board lands accepted items', 'wait for automatic landing; a person can enable landing.manualOverride in accepted trunk policy');
}

/** Return exact conflicting accepted heads before selecting the clean native batch. */
export async function landAcceptedItems({ root, config, trunk, items, reopen, execute }) {
  if (!automaticLandingEnabled(config)) return null;
  for (const item of items) {
    const files = mechanicalConflictFiles(root, trunk, item.commit);
    if (files === null) throw new Refused('LAND_MERGE', 'cannot inspect the accepted head; restore its Git objects so the board can land it');
    if (files.length) await reopen(item.id, { files, trunk });
  }
  const result = await execute();
  if (result?.batch?.state === 'blocked') {
    let output = (result.batch.failures ?? []).map(failure => `${failure.file ?? 'landing guard'}: ${failure.name}`).join('\n');
    if (!output) {
      try { output = readFileSync(result.batch.logPath, 'utf8').slice(-6000); } catch { output = result.batch.logPath ?? 'no retained gate output'; }
    }
    for (const item of result.batch.items ?? []) await reopen(item.id, null, `automatic landing failed: ${output}`);
  }
  return result;
}
