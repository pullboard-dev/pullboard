#!/usr/bin/env node
/**
 * The pullboard command. Node 22 announces that node:sqlite is experimental; that notice is noise
 * for a CLI, so it is dropped before the board module loads. Every other warning still prints.
 */

// The board needs node:sqlite, which Node ships unflagged from 22.13. An older Node fails to load it
// with an error that names no remedy, so say what to install before anything loads (P3, P4).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  const message = `this is Node ${process.versions.node}, and pullboard needs Node 22.13 or newer: install it (for example nvm install 22), then run the command again`;
  const args = process.argv.slice(2);
  const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (flags.includes('--json')) {
    // This module is pure output formatting: it never imports the unavailable SQLite module.
    const { commandOutput } = await import('../src/json.js');
    const output = commandOutput(args, { stdout: process.stdout, stderr: process.stderr });
    output.refusal({ code: 'NODE_TOO_OLD', message });
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

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
