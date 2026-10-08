/** Device-sealed presentation uses the same API state as the local view [A4,H5,H15]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as store from './board.js';
import { exportBoard } from './exchange.js';
import { repoInfo } from './git.js';
import { Refused } from './refused.js';
import { loadConfig } from './config.js';
import { projectState } from './serve.js';

/** Capture spec, doctrine, config and board presentation without sending plaintext to a relay. */
export function relayPresentation(root) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  let shouts;
  try { shouts = store.allShouts(board); } finally { store.closeBoard(board); }
  return { version: 1, state: projectState(root), config: loadConfig(root), shouts };
}

/** Resolve one shout from the complete history carried only inside the sealed presentation. */
export function relayPresentationShout(root, id) {
  return presentationShout(relayPresentation(root), id);
}

/** Resolve one addressed shout from an already decoded snapshot without local repository access. */
export function presentationShout(presentation, id) {
  if (!Array.isArray(presentation?.shouts)) throw new Refused('SHOUT_NOT_AVAILABLE', 'this snapshot does not include addressed shout history; refresh it with a current CLI');
  const found = presentation.shouts.find((shout) => shout.shout_id === id);
  if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
  const answer = found.shout_decision ? presentation.shouts.find((shout) => shout.shout_answers === id) ?? null : null;
  return { ...found, decision_state: found.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
}

/** Notice presentation-only changes, including a spec or doctrine edit without a board move. */
export function presentationDigest(presentation) {
  return createHash('sha256').update(JSON.stringify(presentation)).digest('hex');
}

/** Capture importable native tables beside matching API presentation, retrying a concurrent local move. */
export function relaySnapshot(root) {
  const info = repoInfo(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = relayPresentation(info.root);
    const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
    let native;
    try { native = exportBoard(board); } finally { store.closeBoard(board); }
    const presentation = relayPresentation(info.root);
    const event = native.tables.event.at(-1)?.event_id ?? 0;
    if (event === (presentation.state.events[0]?.event_id ?? 0) &&
        presentationDigest(before) === presentationDigest(presentation)) return { ...native, presentation };
  }
  throw new Refused('RELAY_SNAPSHOT_BUSY', 'the local board changed while its presentation was captured; retry the command to publish a consistent sealed checkpoint');
}
