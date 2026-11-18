/** The two-machine outbox fixtures both relay outbox journey files share [B26,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../child.js';
import { runFixtureSetupGit } from '../child.js';
import { relayClientFixture } from './client.js';

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
export function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  const cliPath = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  // Setup commit without hooks (two Node launches); no case here is about the commit hook [C7].
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** Two machines on one accepted relay board with the outbox on, and an item added before the outage. */
export async function twoMachines(t, title, { beforeLink } = {}) {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await beforeLink?.(box);
  await box.link();
  const contested = (await box.cliLocal('add', box.lane, title)).document.item.item_id;
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code, undefined, { inProcess: true });
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the outage');
  return { box, other, contested };
}

/** The milestones a board export holds, by name, with their item numbers as numbers. */
export function milestoneItems(exported) {
  const row = exported.tables.board_meta.find((meta) => meta.meta_key === 'milestones');
  return Object.fromEntries(JSON.parse(row?.meta_value ?? '[]').map((milestone) => [milestone.name, milestone.items.map(Number)]));
}
