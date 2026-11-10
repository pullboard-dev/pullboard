import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';
import { BUILDER_FAMILY_REQUIRED_ENGINE } from '../../../../state/light.js';
import { frozenFamilyPolicy } from '../relaxation.js';

/** Require the native derived family under current or frozen required-family authority, preserving older moves. */
export function builderFamilyProblem(board, item, agentId, familyPolicy = 'off') {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BUILDER_FAMILY_REQUIRED_ENGINE
      || familyPolicy !== 'require' && frozenFamilyPolicy(item, 'off') !== 'require') return null;
  if (board.nativePorts.canonicalFamily(board, board.nativePorts.seatFamily(board, agentId))) return null;
  return new Refused('UNDECLARED_BUILDER_FAMILY',
    `#${item.item_id} requires a declared builder family; run pullboard join <lane> --family <vendor> --model "<model name>", then retry`);
}
