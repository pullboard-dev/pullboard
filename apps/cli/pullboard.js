#!/usr/bin/env node
/**
 * The pullboard command. Node 22 announces that node:sqlite is experimental; that notice is noise
 * for a CLI, so it is dropped before the board module loads. Every other warning still prints.
 */

// The board needs node:sqlite, which Node ships unflagged from 22.13. An older Node fails to load it
// with an error that names no remedy, so say what to install before anything loads (P3, P4).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  const next = 'install it (for example nvm install 22), then run the command again';
  const message = `this is Node ${process.versions.node}, and pullboard needs Node 22.13 or newer: ${next}`;
  const args = process.argv.slice(2);
  const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (flags.includes('--json')) {
    // This module is pure output formatting: it never imports the unavailable SQLite module.
    const {
      commandOutput,
      versionedRefusal,
    } = await import('../../packages/config/browser.js');
    const output = commandOutput(args, { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
    output.refusal({ code: 'NODE_TOO_OLD', message, next });
    output.flush(1);
  } else process.stderr.write(`pullboard: [NODE_TOO_OLD] ${message}\n`);
  process.exit(1);
}

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

// A reader that stops early, like head, closes the pipe, and the rest of the output has nowhere to
// go: end quietly, as other command-line tools do, rather than print a stack trace (N24).
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(process.exitCode ?? 0);
});

// The common version probe needs only the release metadata, not the command dispatcher.
if (process.argv.length === 3 && process.argv[2] === '--version') {
  const { default: packageData } = await import('../../package.json', { with: { type: 'json' } });
  process.stdout.write(`${packageData.version}\n`);
  process.exit(0);
}

// A self-hosted pre-commit runs from the staged index with the item's companions applied, never the working tree (#2593).
if (process.argv[2] === 'hook') {
  const composed = await (await import('./src/io/hook/composed.js')).runComposedHook(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env });
  if (composed !== null) process.exit(composed);
}

// Select immutable tooling before redirecting a stale worktree to today's CLI.
// Only these two small modules load here; the dispatcher loads after the resident path declines, so a warm client stays thin [H24].
const { selectedToolEntry, asksVersion } = await import('./light.js');
if (process.argv[2] !== 'tool-build' && !asksVersion(process.argv.slice(2))) {
  try {
    const selected = await selectedToolEntry(process.cwd(), process.argv[1]);
    if (selected) {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [selected, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
      process.exit(result.status ?? 1);
    }
  } catch (error) {
    if (process.argv.includes('--json')) {
      const { commandOutput, versionedRefusal } = await import('../../packages/config/browser.js');
      const output = commandOutput(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
      output.refusal({ code: error.code ?? 'TOOL_BUILD_UNAVAILABLE', message: error.message,
        next: 'ask the coordinator to promote a native gated tool build' });
      output.flush(1);
    } else process.stderr.write(`pullboard: [${error.code ?? 'TOOL_BUILD_UNAVAILABLE'}] ${error.message}\n`);
    process.exit(1);
  }
}

// A worktree behind the main checkout runs the main checkout's CLI after checking its own pin.
const handed = (await import('./src/io/current.js')).runCurrentCli(process.argv[1]);
if (handed !== null) process.exit(handed);

// A warm resident board process runs the command when one serves this checkout; otherwise it runs here.
const resident = await (await import('./src/io/resident/client.js')).runResident(process.argv.slice(2));
if (resident !== null) process.exitCode = resident;
else if (process.argv[2] === 'hook' && (await import('./src/io/hook/thin-door.js')).isThinHook(process.argv.slice(2), process.env)) {
  // A commit hook outside an agent session runs hookCommand alone: no dispatcher, no checkout lease to bind [H24].
  const { runThinHook } = await import('./src/io/hook/thin.js');
  process.exitCode = await runThinHook(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
} else {
  // Mark this command as the outermost live pullboard for every child it starts, unless a live outer one already
  // did: a pullboard test under a gate, check or landing then blocks and returns its real exit code [C7].
  const outer = Number(process.env.PULLBOARD_CLI_PID);
  let outerAlive = false;
  if (Number.isSafeInteger(outer) && outer > 0 && outer !== process.pid) {
    try { process.kill(outer, 0); outerAlive = true; } catch (error) { outerAlive = error?.code === 'EPERM'; }
  }
  if (!outerAlive) process.env.PULLBOARD_CLI_PID = String(process.pid);
  const { cliMain$main: main } = await import('./index.js');
  const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import('./src/io/ports/process.js');
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    loadNativeBoard,
    gateWaitReporter,
    loadProcessPorts,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
}
