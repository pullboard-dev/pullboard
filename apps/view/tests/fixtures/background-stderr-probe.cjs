/**
 * Preloaded into the detached view a test starts: on SIGUSR2 it writes one line to stderr, as the server's first
 * runtime warning (Node's SQLite ExperimentalWarning) does after the command that started it has exited.
 */
process.on('SIGUSR2', () => { process.stderr.write('probe: first runtime warning after the parent let go\n'); });
