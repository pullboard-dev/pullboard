/** Keep one compatibility setup move recoverable without stealing an interrupted work result [S1,H16]. */
import { loadConfig } from '../../../../config/index.js';
import { captureSpecApprovalBaseline } from '../approval.js';

/** Establish cold local authority inside the checkout lease; linked and recovered moves keep relay authority. */
export function ensureSpecApprovalCoordinator(ctx, board, baseline, { relayLinked, relayRecovered, gitSyncLinked, ensureCoordinator }) {
  if (!baseline || !ctx.info.isMain || relayLinked(ctx.info.root) || relayRecovered(ctx.info.root) || gitSyncLinked(ctx.info.root)) return;
  ensureCoordinator(board, ctx.info.root);
}

/** Reuse the exact interrupted setup payload; only a main-checkout command can establish it. */
export function initialSpecApprovalBaseline(ctx, board, operation, { relayRecovered, specApprovalBaselineExists }) {
  if (!ctx.info.isMain || operation === 'recordSpecApprovalBaseline') return null;
  const recovered = relayRecovered(ctx.info.root, { includePending: true });
  // A pending send or catch-up can retain the original move while its setup reply is still unreported.
  // Repeating that same move consumes its receipt through ordinary relay validation, not a new seed.
  if (recovered?.operation === 'recordSpecApprovalBaseline') return recovered.args[0].baseline;
  return specApprovalBaselineExists(board) ? null : captureSpecApprovalBaseline(ctx.info.root, loadConfig(ctx.info.root));
}
