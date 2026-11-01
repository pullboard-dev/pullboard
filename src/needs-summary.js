/** Status obligations without loading the dashboard projection [N26,A9]. */
import { verifiedPasskeyRowDecision } from '../packages/person/index.js';
import * as store from '../packages/store/index.js';
import { repoInfo } from './git.js';
import { projectRowDecisions } from '../packages/spec/index.js';
import { loadSpec } from '../packages/spec/index.js';
import { loadDoctrine } from './doctrine.js';
import { rigorDraftNeeds } from '../packages/rigor/index.js';
import { personBlockWords } from '../packages/items/index.js';
import { displayAgentName } from './agent-names.js';
import {
  projectSpecApprovals,
  specApprovalState,
} from '../packages/spec/index.js';
import {
  sentinelDraftNeeds,
  sentinels,
} from '../packages/store/index.js';
import { relayCanaryNeeds } from '../packages/link/index.js';

/** Keep status obligations; reuse its same-call seats and doctrine, otherwise read them freshly. */
export function personNeedsSummary(root, { board, config, agents, doctrine }) {
  const spec = loadSpec(root, config);
  const rows = projectRowDecisions(store.rowDecisions(board), { root, spec: spec.rows, practice: (doctrine ?? loadDoctrine(root, config)).rows });
  const projected = projectSpecApprovals({ ...rows,
    decisions: store.openDecisions(board, store.PERSON), holds: store.laneHolds(board),
    agents: (agents ?? store.listAgents(board)).map(agent => ({ ...agent, displayName: displayAgentName(agent, config.agents.names) })),
    rigorDrafts: rigorDraftNeeds(rows, store.rowDrafts(board), store.rowDecisions(board)), sentinelDrafts: sentinelDraftNeeds(sentinels(board)), blocks: recentBlocks(repoInfo(root).commonDir, board),
  }, specApprovalState(root, { board, config, spec }, { store, verifiedPasskeyRowDecision }));
  const relayHealthAlerts = relayCanaryNeeds(root);
  return { ...projected, relayHealthAlerts, needs: [...projected.needs, ...relayHealthAlerts] };
}

/** The person's blocks from the last day, by the board's clock, for Needs you [C6]. */
export function recentBlocks(commonDir, board) {
  return personBlockWords(commonDir, (board?.clock ?? store.systemClock).now());
}
