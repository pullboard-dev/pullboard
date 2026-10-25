/** Native signed membership routing [E17,H16]. */
import { BOARD_MEMBERS_ENGINE } from '../board-members-engine.js';
export default Object.freeze({ operation: 'setBoardMembers', engine: 1, itemIdFirstArgument: false,
  minimumEngine: () => BOARD_MEMBERS_ENGINE, actor: move => move.args[0]?.agentId ?? null,
  nextSteps: Object.freeze({
    COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator "<what you need>"',
    BOARD_MEMBERS_INVALID: 'ask a committed approver to publish a complete signed board member list',
    BOARD_MEMBERS_REVISION: 'read the current member revision, then sign a new list',
    ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
  }) });
