/** Owner-only relay key files and legacy keychain migration [H15,H17]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { constants } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/**
 * Copy this Node into a folder whose name has a space, as on a machine where Node lives under such a path (#865).
 * A shebang cannot hold that path, so every wrapper below must start Node through the shell instead.
 */
function nodeAtSpacedPath(box) {
  const folder = join(box.env.PULLBOARD_HOME, 'node with spaces');
  mkdirSync(folder, { recursive: true });
  const node = join(folder, 'node');
  copyFileSync(realpathSync(process.execPath), node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o700);
  return node;
}

/** Install an isolated `security` command without consulting the host keychain. */
function securityStandIn(box) {
  const store = join(box.env.PULLBOARD_HOME, 'legacy-keychain-entry');
  const security = join(box.env.PATH, 'security');
  const program = join(box.env.PULLBOARD_HOME, 'security stand-in.cjs');
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(nodeAtSpacedPath(box))} ${JSON.stringify(program)} "$@"\n`;
  const script = [
    "const { existsSync, readFileSync, rmSync } = require('node:fs');",
    'const command = process.argv[2];',
    "if (['list-keychains', 'search'].includes(command)) process.exit(0);",
    "if (['find-generic-password', 'lookup'].includes(command)) {",
    "  if (process.env.SECURITY_MODE !== 'available') process.exit(1);",
    "  if (!existsSync(process.env.KEYCHAIN_STORE)) process.exit(command === 'lookup' ? 1 : 44);",
    "  process.stdout.write(readFileSync(process.env.KEYCHAIN_STORE));",
    "} else if (['delete-generic-password', 'clear'].includes(command)) rmSync(process.env.KEYCHAIN_STORE, { force: true });",
    'else process.exit(1);',
  ].join('\n');
  writeFileSync(program, script, { mode: 0o600 });
  for (const executable of [security, join(box.env.PATH, 'secret-tool')]) {
    writeFileSync(executable, wrapper, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  box.env.KEYCHAIN_STORE = store;
  box.env.SECURITY_MODE = 'locked';
  return store;
}

test('owner-only key file links and reads with a locked keychain, migrates once, and supports the environment key [H15,H17]', async (t) => {
  const box = await relayClientFixture(t);
  // Keep the real generated hook active on the fixture's deliberately private PATH.
  const cli = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
  // Item reads use accepted main's family policy, so commit the policy that init generated.
  runFixtureGit(['add', 'pullboard.json', 'SPEC.md', 'AGENTS.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: commit private relay policy'], { cwd: box.root, env: box.env });
  securityStandIn(box);

  const linked = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(linked.code, 0,
    'relay on succeeds when the available security command reports a locked keychain');
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  assert.equal(linked.document.link.endsWith('&key=' + encoded), true, 'the intended pairing field carries the generated key');
  const { link: pairingLink, ...publicLinkResult } = linked.document;
  assert.equal(JSON.stringify(publicLinkResult).includes(encoded), false, 'the JSON result has no key outside its pairing field');
  for (const args of [['status'], ['show', '1'], ['relay'], ['show', '999999']]) {
    const result = await box.cli(...args);
    assert.equal(result.code, args[1] === '999999' ? 1 : 0,
      `${args.join(' ')} completes; refusal code: ${result.document?.error?.code ?? 'none'}`);
    assert.equal(JSON.stringify(result.document).includes(encoded), false, 'ordinary status, show, relay and refusals never contain the board key');
  }
  const text = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    import { readFileSync } from 'node:fs';
    const key = readFileSync(${JSON.stringify(box.keyFile)}, 'utf8').trim();
    let output = '', errors = '';
    const streams = { cwd: ${JSON.stringify(box.root)},
      stdout: { write: part => { output += part; } }, stderr: { write: part => { errors += part; } } };
    const linkedCode = await main(['relay', 'on', '--url', ${JSON.stringify(box.origin)}], streams);
    const carriers = output.split('\\n').filter(line => line.includes(key));
    const pairingOnly = carriers.length === 1 && carriers[0].startsWith('https://app.pullboard.dev/#board=') && carriers[0].endsWith('&key=' + key);
    output = '';
    const statusCode = await main(['status'], streams);
    const refusalCode = await main(['show', '999999'], streams);
    console.log(JSON.stringify({ version: 1, linkedCode, statusCode, refusalCode, pairingOnly,
      ordinaryLeak: output.includes(key), errorLeak: errors.includes(key) }));
  `);
  assert.equal(text.code, 0, 'the real text-output probe completes without printing its captured key');
  assert.deepEqual(text.document, { version: 1, linkedCode: 0, statusCode: 0, refusalCode: 1,
    pairingOnly: true, ordinaryLeak: false, errorLeak: false }, 'text output shows the key once in its pairing link and nowhere in ordinary output or errors');
});
