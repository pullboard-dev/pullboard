/** A recovered move's durable outcome, in its own module so commands reach it without the CLI module [B26]. */
import { engineReceipt } from './engine.js';

/** Return the durable outcome only when a recovered move exactly matches its original receipt. */
export function recordedRecovery(board, move) {
  const receipt = engineReceipt(board, move.id);
  return receipt?.move === JSON.stringify(move) ? receipt : null;
}
