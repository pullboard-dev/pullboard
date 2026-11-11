/**
 * Test-only entry (#408), never published: runs the shipped command with the loopback fixture relay handed in as
 * `trustedRelayOrigin`, an explicit parameter in the test's own call path. The shipped apps/cli/pullboard.js has no such
 * switch, so outside a test the person authority comes only from the built-in relay over TLS.
 *
 * Usage: node apps/cli/tests/fixtures/person/trusted.js <fixture relay origin> <pullboard arguments...>
 */
const [trustedRelayOrigin, ...argv] = process.argv.slice(2);
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};
const { main } = await import('../native.js');
process.exitCode = await main(argv, { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, trustedRelayOrigin, loadNativeBoard: () => import('../../../../lib/index.js') });
