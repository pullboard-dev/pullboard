#!/usr/bin/env node
/** Private detached baseline worker; no command or caller-supplied result comes from its arguments [V2,H16]. */
const emitWarning = process.emitWarning;
/** Hide only Node's experimental SQLite notice, as the main CLI does. */
process.emitWarning = (warning, ...rest) => {
  if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
};
const [root, rawId, request] = process.argv.slice(2);
if (root && /^[1-9]\d*$/.test(rawId ?? '') && /^[a-f0-9-]{36}$/.test(request ?? '')) {
  const { runCheckBaselineWorker } = await import('../src/check-baseline-worker.js');
  try { await runCheckBaselineWorker(root, Number(rawId), request); }
  catch { process.exitCode = 1; }
} else process.exitCode = 2;
