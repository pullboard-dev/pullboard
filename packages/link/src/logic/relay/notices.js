const WARNED_COMMANDS = new WeakSet();
const STORAGE_WARNED_COMMANDS = new WeakSet();

/** Print relay warnings once per command, keeping account storage notices distinct from refusal behavior. */
export function relayNotices(document, io) {
  const warnings = [document.warning, document.state?.warning, ...(document.warnings ?? [])].filter(Boolean);
  if (!io || typeof io !== 'object' || typeof io.err !== 'function') return;
  for (const warning of warnings) {
    if (warning.code === 'BOARD_INACTIVE' && !WARNED_COMMANDS.has(io)) {
      WARNED_COMMANDS.add(io);
      io.err(`pullboard: [BOARD_INACTIVE] ${warning.daysLeft} days left before this relay board is deleted; ${warning.next || 'make a board move before the deadline to keep it'}`);
    } else if (['ACCOUNT_STORAGE_WARNING', 'ACCOUNT_STORAGE_LIMIT'].includes(warning.code) && !STORAGE_WARNED_COMMANDS.has(io)) {
      STORAGE_WARNED_COMMANDS.add(io);
      io.err(`pullboard: [${warning.code}] ${warning.message}`);
    }
  }
}
