/** Internal execution scope for transport-validated recorded moves, never a serialized authority flag [V4,H16]. */
const SCOPES = new WeakMap();

/** Enter only after the transport validates its immutable Git prefix or authenticates its sealed relay record.
 * The callback is synchronous: the scope cannot escape into another queued operation on this board.
 */
export function withRecordedConflictContext(board, move, position, execute) {
  const previous = SCOPES.get(board);
  const scope = { move, bytes: JSON.stringify(move), sequence: position.sequence, at: position.at };
  SCOPES.set(board, scope);
  try { return execute(); }
  finally {
    if (previous) SCOPES.set(board, previous);
    else SCOPES.delete(board);
  }
}

/** Match the exact current recorded position and computed evidence, not caller-supplied labels or hashes. */
export function isRecordedConflictContext(board, item, actor, receipt) {
  const scope = SCOPES.get(board);
  if (!scope || scope.move.operation !== 'reopen' || JSON.stringify(scope.move) !== scope.bytes ||
      !Number.isSafeInteger(scope.sequence) || !Number.isFinite(Date.parse(scope.at))) return false;
  const cursor = Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get()?.meta_value ?? 0);
  const [id, options] = scope.move.args;
  return scope.sequence === cursor + 1 && id === item.item_id && options?.agentId === actor &&
    JSON.stringify(options.computedConflict) === JSON.stringify(receipt);
}
