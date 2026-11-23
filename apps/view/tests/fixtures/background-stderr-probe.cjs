/**
 * Preloaded into the detached view a test starts: when the command that started it lets go (its IPC channel closes),
 * it writes one line to stderr, as the server's first runtime warning (Node's SQLite ExperimentalWarning) does once
 * that command has exited.
 */
process.on('disconnect', () => { process.stderr.write('probe: first runtime warning after the parent let go\n'); });
