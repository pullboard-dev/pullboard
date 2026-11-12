/** Board-only replay guards stay outside both the oversized board and the trusted runner runtime [E28,E29]. */
import { carriesLandingEnvironment } from '../../../sandbox/index.js';
import { environmentProblem } from '../../../config/index.js';
import { LANDING_ENVIRONMENT_ENGINE } from '../../../state/light.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { Refused } from '../../../kernel/index.js';

/** Preserve the replay engine instead of assigning current semantics to an old move. */
function engine(board) { return board.executionEngineVersion ?? ENGINE_VERSION; }

/** Validate optional verdict metadata while preserving historical absence and explicit unknowns. */
export function requireVerdict(board, environment) {
  if (environment !== undefined && engine(board) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `verdict environments require engine ${LANDING_ENVIRONMENT_ENGINE}`);
  if (environment !== undefined && environment !== null && environmentProblem(environment)) throw new Refused('VERDICT_ENVIRONMENT', 'a verdict environment needs exact platform, arch and Node version');
}

/** An older engine cannot start or finish a batch around a durable test-defect hold. */
export function requireTrunk(board) {
  if (engine(board) < LANDING_ENVIRONMENT_ENGINE && board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'landing-test-defect' LIMIT 1").get()) throw new Refused('ENGINE_VERSION', `this trunk has test-defect holds requiring engine ${LANDING_ENVIRONMENT_ENGINE}`);
}

/** Require the engine and exact executor identities before recording a batch. */
export function requireBatch(board, batch) {
  requireTrunk(board);
  if (carriesLandingEnvironment(batch) && engine(board) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `landing environments and test defects require engine ${LANDING_ENVIRONMENT_ENGINE}`);
  if (batch?.environmentWarnings !== undefined && !Array.isArray(batch.environmentWarnings)) throw new Refused('LAND_BATCH', 'landing environment warnings are a list');
  const environments = [batch?.environment, ...(Array.isArray(batch?.gateResults) ? batch.gateResults : []).map(gate => gate?.environment),
    ...(batch?.environmentWarnings ?? []).flatMap(warning => [warning?.recorded, warning?.landing])];
  if (environments.some(environment => environment !== undefined && environment !== null && environmentProblem(environment))) throw new Refused('LAND_BATCH', 'a landing executor needs exact platform, arch and Node version');
}

/** An older replay cannot reinterpret an existing typed batch. */
export function requireStoredBatch(board, batch) {
  if (carriesLandingEnvironment(batch) && engine(board) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `this batch requires engine ${LANDING_ENVIRONMENT_ENGINE}`);
}

/** Keep the executor and test-defect evidence across every batch revision. */
export function requireRevision(board, previous, batch) {
  requireStoredBatch(board, previous);
  if (previous && ['environment', 'testDefects'].some(key => Object.hasOwn(previous, key) && !Object.hasOwn(batch, key))) throw new Refused('LAND_BATCH', 'a landing revision keeps its recorded executor and test defects');
}
