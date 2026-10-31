#!/usr/bin/env node
/** Private detached baseline worker; no command or caller-supplied result comes from its arguments [V2,H16]. */
const emitWarning = process.emitWarning;
/** Hide only Node's experimental SQLite notice, as the main CLI does. */
process.emitWarning = (warning, ...rest) => {
  if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
};
const [root, rawId, request] = process.argv.slice(2);
if (root && /^[1-9]\d*$/.test(rawId ?? '') && /^[a-f0-9-]{36}$/.test(request ?? '')) {
  const { openBoard } = await import('../src/native-board.js');
  const { withOutboxGuard } = await import('../src/relay-outbox-guard.js');
  const { replay: replayConflictRecord } = await import('../src/relay-conflict-record.js');
  const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import('../src/relay-baseline-settle.js');
  const { runCheckBaselineWorker } = await import('../src/check-baseline-worker.js');
  try { await runCheckBaselineWorker(root, Number(rawId), request, { openBoard, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline }); }
  catch { process.exitCode = 1; }
} else process.exitCode = 2;
