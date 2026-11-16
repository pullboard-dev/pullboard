/** A publish pause reads the original full-run receipt and the existing same-tree flake ledger [C7,V4]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { boardFolderFile } from '../../../git/index.js';
import {
  readGateReceipt,
  receiptBinds,
  receiptStore,
} from '../../../gate/index.js';
import { Refused } from '../../../kernel/index.js';

/** Shared publish state belongs to the repository, including its private landing worktrees. */
export function publishStateFile(root) {
  return boardFolderFile(root, 'publish.json');
}

/** Record publish's verdict beside the other private Git state; this module owns the store, so every writer comes here. */
export function writePublishState(root, state) {
  writeFileSync(publishStateFile(root), JSON.stringify(state) + '\n');
}

/** Absence is the normal pre-publish state; malformed recorded evidence must remain visible. */
export function readPublishState(root) {
  try { return JSON.parse(readFileSync(publishStateFile(root), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Refused('PUBLISH_RED', 'publish state cannot be read; preserve publish.json and recover its original full-suite receipt before landing');
  }
}

/**
 * Refuse new landing work until a full green or a bound same-tree green proves every named failure flaky.
 * With `perItem`, a red that names files returns the hold instead of throwing, so landing can exclude only the
 * items whose diff touches those files; a red naming no file still throws and pauses all landing [C7].
 *
 * @param {string} root - Repository root.
 * @param {object} board - The board handle.
 * @param {object} config - Accepted trunk policy.
 * @param {object} ports - Landing ports, including gateRuns.
 * @param {{ perItem?: boolean }} [options] - perItem returns a file-named hold rather than throwing.
 * @returns {{ files: string[], refusal: Refused }|null} The per-item hold, or null when publish is not red.
 */
export function requirePublishGreen(root, board, config, ports, { perItem = false } = {}) {
  if (config.landing?.pauseOnRed !== true) return null;
  const state = readPublishState(root);
  if (!state?.red) return null;
  const store = receiptStore(root);
  const red = readGateReceipt(store, state.receipt);
  if (!red || red.green || red.head !== state.red || red.kind !== 'land') {
    throw new Refused('PUBLISH_RED', `publish full suite is red at ${state.red}; its original receipt is unavailable; run publish on a corrected head before landing`);
  }
  const paired = ports.gateRuns(board).some(run => run.by === 'coordinator' && run.green
    && run.tree === red.tree && run.command === red.command && receiptBinds(store, run));
  if (paired && red.failures.length > 0) return null;
  const hold = publishRedHold(state, red);
  if (perItem && hold.files.length) return hold;
  throw hold.refusal;
}

/**
 * The refusal and the file names behind one red publish: files come from publish.json's failures and the original
 * receipt's failures. A red naming no file has an empty list, which keeps the pause on every item [C7].
 *
 * @param {{ failures?: { file?: string, name?: string, items?: number[] }[] }} state - publish.json.
 * @param {{ head: string, failures: { file?: string, name?: string }[] }} red - The original full-run receipt.
 * @returns {{ files: string[], refusal: Refused }}
 */
export function publishRedHold(state, red) {
  const details = red.failures.map(failure => {
    const attribution = state.failures?.find(entry => entry.file === failure.file && entry.name === failure.name);
    return `${failure.file}: ${failure.name}; last changed by ${attribution?.items?.length ? '#' + attribution.items[0] : 'no recorded landed item'}`;
  });
  const refusal = new Refused('PUBLISH_RED', `publish full suite is red at ${red.head}; landing pauses until a later full suite passes or the same tree proves flaky: ${details.join('; ') || '(unnamed failure)'}`);
  const files = [...new Set([...(state.failures ?? []), ...red.failures].map(failure => failure.file).filter(Boolean))];
  return { files, refusal };
}

/**
 * The red files an item's diff touches; an empty list means the item is not held by the red publish.
 *
 * @param {string[]} redFiles - Files the red publish names.
 * @param {string[]} changed - Files the item's diff changes.
 * @returns {string[]}
 */
export function publishRedTouched(redFiles, changed) {
  return changed.filter(file => redFiles.includes(file));
}
