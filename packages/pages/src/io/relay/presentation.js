import { presentationShout } from '../../logic/relay/presentation.js';
/** Device-sealed presentation uses the same API state as the local view [A4,H5,H15]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as store from "../../../../store/index.js";
import { exportBoard } from "../../../../store/index.js";
import {
  codeIsFromMain,
  repoInfo,
  withGitReadFacts,
} from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";
import { loadConfig } from "../../../../config/index.js";
import { buildLocalBoardState } from "../../../../store/index.js";
import { stateFileInputs } from "../../../../store/index.js";
import { fileRevision } from "../../../../store/index.js";
import { resolveCommit } from "../../../../git/index.js";
import { trunkRevisionReader } from "../../../../git/index.js";
import { cachedVerdictStates } from "../../../../verify/index.js";
import { compareFlowWindows } from "../../../../stats/light.js";
import { recordedClaimWorktrees } from "../../../../activity/index.js";
import { claimOverlaps } from "../../../../items/index.js";

// A comparison clock is an internal fingerprint input, never a displayed forecast or observation.
const COMPARISON_CLOCK = Date.UTC(2000, 0, 1);

/** Refuse incomplete upper bindings before repository discovery, clocks, Git or database effects. */
function requirePresentationPorts(ports) {
  if (!ports || typeof ports.openBoard !== 'function' || typeof ports.verifiedPasskeyRowDecision !== 'function' || typeof ports.pendingFit !== 'function' || typeof ports.projectFit !== 'function' || typeof ports.projectState !== 'function' || typeof ports.personRequestStatuses !== 'function' || typeof ports.personSigningPresentation !== 'function' || typeof ports.activeViewAgents !== 'function' || typeof ports.viewProofSummary !== 'function' || typeof ports.fitFile !== 'function') {
    throw new Refused('RELAY_PRESENTATION_PORTS', 'relay presentation requires its complete native upper provider map; use the current native composition entrypoint');
  }
  return ports;
}

/** Capture spec, doctrine, config and board presentation without sending plaintext to a relay. */
export function relayPresentation(root, options = {}, ports) {
  requirePresentationPorts(ports);
  const { board: providedBoard = null, observedAt = providedBoard ? providedBoard.clock.now().getTime() : Date.now() } = options;
  return withGitReadFacts(() => readRelayPresentation(root, providedBoard, observedAt, ports));
}

/** Build both clocks through the same pure projection; only the actual observation is emitted as state. */
function readRelayPresentation(root, providedBoard, observedAt, ports) {
  requirePresentationPorts(ports);
  const { fitFile } = ports;
  const info = repoInfo(root);
  const isMain = codeIsFromMain();
  const board = providedBoard ?? ports.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain });
  try {
    const boardId = store.boardId(board);
    const config = loadConfig(root);
    const projects = () => [{ root: info.root, name: config.name, project: config.project }];
    // Staged caller boards retain fresh reads; only ordinary owned reads reuse committed verdict state.
    const freshnessReader = providedBoard ? null : cachedVerdictStates(root, board, info, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, boardId: store.boardId });
    const items = store.listItems(board);
    const overlaps = claimOverlaps(items, recordedClaimWorktrees(items, store.listAgents(board), board));
    const overlapState = Object.fromEntries([...overlaps].filter(([, value]) => value.overlaps.length || value.outOfScope.length));
    /** Preserve a single authorized board, including existing unavailable external milestone entries. */
    const project = (clock) => {
      const built = buildLocalBoardState(root, boardId, board, isMain, { projects, scopeCommonDir: info.commonDir, observedAt: clock, freshnessReader }, { ...ports, openBoard: ports.openBoard });
      return { ...built.state, sequence: built.sequence, claimOverlaps: overlapState,
        statsComparison: compareFlowWindows(built.history, { now: clock, windowMinutes: 120, complete: true }) };
    };
    const state = project(observedAt);
    const comparison = project(COMPARISON_CLOCK);
    // exportBoard omits only derived proof counters and machine-local landing lease cache rows.
    // Exact source bytes also retain expired/hidden business inputs that a fixed-clock view may omit.
    // The comparison projects every person-visible block. Private agent recovery lines are not sealed inputs.
    const files = stateFileInputs(root, config, { fitFile }).filter(file => file.name !== 'blocks:blocks.jsonl').map(fileRevision);
    // Heartbeats are sealed observations even when the fixed-clock view hides their seats.
    // Keep their exact values, excluding clock-derived presence and activity-window membership.
    const heartbeats = store.listAgents(board).map(({ agent_id, heartbeatAt }) => ({ agent_id, heartbeatAt }));
    const inputs = { native: exportBoard(board), files, heartbeats,
      head: resolveCommit(root, 'HEAD'), trunk: trunkRevisionReader(info)(), config };
    const changeFingerprint = createHash('sha256').update(JSON.stringify({ inputs, comparison })).digest('hex');
    return { version: 1, state, config, shouts: store.allShouts(board), changeFingerprint };
  } finally { if (!providedBoard) store.closeBoard(board); }
}
/** Resolve one shout from the complete history carried only inside the sealed presentation. */
export function relayPresentationShout(root, id, ports) {
  requirePresentationPorts(ports);
  return presentationShout(relayPresentation(root, {}, ports), id);
}

/** Notice presentation-only changes, including a spec or doctrine edit without a board move. */
export function presentationDigest(presentation) {
  return /^[a-f0-9]{64}$/u.test(presentation?.changeFingerprint ?? '')
    ? presentation.changeFingerprint
    : createHash('sha256').update(JSON.stringify(presentation)).digest('hex');
}

/** Capture importable native tables beside matching API presentation, retrying a concurrent local move. */
export function relaySnapshot(root, options = {}, ports) {
  requirePresentationPorts(ports);
  const { board: providedBoard = null, observedAt = providedBoard ? providedBoard.clock.now().getTime() : Date.now() } = options;
  return withGitReadFacts(() => readRelaySnapshot(root, providedBoard, observedAt, ports));
}

/** Keep native tables and their device presentation at one observed board revision. */
function readRelaySnapshot(root, providedBoard, observedAt, ports) {
  requirePresentationPorts(ports);
  const info = repoInfo(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = providedBoard ? null : relayPresentation(info.root, { observedAt }, ports);
    const board = providedBoard ?? ports.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
    let native;
    try { native = exportBoard(board); } finally { if (!providedBoard) store.closeBoard(board); }
    const presentation = relayPresentation(info.root, { board: providedBoard, observedAt }, ports);
    const event = native.tables.event.at(-1)?.event_id ?? 0;
    if (event === (presentation.state.events[0]?.event_id ?? 0) &&
        (providedBoard || presentationDigest(before) === presentationDigest(presentation))) return { ...native, presentation };
  }
  throw new Refused('RELAY_SNAPSHOT_BUSY', 'the local board changed while its presentation was captured; retry the command to publish a consistent sealed checkpoint');
}
