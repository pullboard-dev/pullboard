/** Two local boards go from pullboard link to a foreign wait: the consumer's claim of an item that waits on an open provider item is refused [XB1,B24,E32]. @pullboard-world-pin: clause 2 reads this file's own source by path to prove the case body calls no store or linkBoards; no fixture can say that. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { addSigner } from '../../../../packages/spec/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const PRINCIPAL = 'agent@example.com';

/** One ssh-keygen signer in a board's sandbox, returning the private key path. */
function signerKey(box, name) {
  const key = join(box.dir, name);
  const generated = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  return key;
}

/**
 * Two real boards in one project registry, each with its own signer: the provider and the consumer.
 * Why PULLBOARD_HOME too: the project registry file lives under it, so the machine home alone leaves the two boards unaware of each other.
 * The provider's signer is its git principal, the one pullboard link signs the child side with; the consumer's key is named by --by and --key.
 */
async function twoBoards() {
  const provider = helpers.project('true', helpers.sandbox());
  const other = helpers.sandbox();
  other.env.PULLBOARD_MACHINE_HOME = provider.env.PULLBOARD_MACHINE_HOME;
  other.env.PULLBOARD_HOME = provider.env.PULLBOARD_HOME;
  const consumer = helpers.project('true', other);
  const providerKey = signerKey(provider, 'provider-signer');
  const consumerKey = signerKey(consumer, 'consumer-signer');
  addSigner(provider.repo, { by: PRINCIPAL, key: `${providerKey}.pub` });
  addSigner(consumer.repo, { by: 'consumer-parent', key: `${consumerKey}.pub` });
  // The link signs the child side with the key git names for the child's principal; the consumer's own process reads it from its git environment.
  consumer.env.GIT_CONFIG_COUNT = '1';
  consumer.env.GIT_CONFIG_KEY_0 = 'user.signingkey';
  consumer.env.GIT_CONFIG_VALUE_0 = providerKey;
  await provisionBoardKey(consumer);
  return { provider, consumer, consumerKey };
}

/** Give the local link its private envelope key in the fixture's machine home. */
async function provisionBoardKey(box) {
  const previous = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  try {
    const { boardId } = await import('../../../../packages/store/index.js');
    const { storeBoardKey } = await import('../../../../packages/keys/index.js');
    helpers.board(box, board => storeBoardKey(boardId(board), Buffer.alloc(32, 124)));
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previous;
  }
}

test('cli.journeys-fact-repo-local.consumer-claim-waits-on-provider: clause 1: link, add --after provider#id and claim by commands on two local boards refuse the claim as waiting on the provider item [XB1,B24,E32]', async () => {
  const { provider, consumer, consumerKey } = await twoBoards();
  const providerId = fileFixtureItem(provider, provider.repo, { lane: 'web', title: 'Provider work', diagnose: false }).item_id;

  const linked = consumer.run(consumer.repo, 'link', 'repo', '--by', 'consumer-parent', '--key', consumerKey);
  assert.equal(linked.code, 0, linked.err + linked.out);
  assert.match(linked.out, /linked board-repo: board is the parent of repo/u);

  const waitingId = fileFixtureItem(consumer, consumer.repo, { lane: 'web', title: 'Waits on provider', diagnose: false, args: ['--after', `repo#${providerId}`] }).item_id;

  const refused = consumer.run(consumer.web, 'claim', String(waitingId));
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(`${refused.err}${refused.out}`, new RegExp(`#${waitingId} waits on repo#${providerId}`, 'u'));
  assert.match(`${refused.err}${refused.out}`, /BLOCKED|on its own board/u);
});

test('cli.journeys-fact-repo-local.journey-uses-only-commands: clause 2: the first case calls no store.* or linkBoards; addSigner and ssh-keygen are its only calls that are not pullboard commands [XB1]', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const body = source.slice(source.indexOf("test('cli.journeys-fact-repo-local.consumer-claim"), source.indexOf("test('cli.journeys-fact-repo-local.journey-uses"));
  assert.doesNotMatch(body, /\bstore\./u);
  assert.doesNotMatch(body, /linkBoards/u);
  assert.doesNotMatch(source.slice(0, source.indexOf('const helpers')), /packages\/store/u);
  assert.match(source, /addSigner\(/u);
});

test('cli.journeys-fact-repo-local.verified-provider-refreshes-consumer-before-claim: provider claim, submit and verify and consumer claim use commands; the consumer refreshes the signed file delivery and claims only after verification [XB1,B24,E32]', async () => {
  const { provider, consumer, consumerKey } = await twoBoards();
  const linked = consumer.run(consumer.repo, 'link', 'repo', '--by', 'consumer-parent', '--key', consumerKey);
  assert.equal(linked.code, 0, linked.err + linked.out);

  const providerId = fileFixtureItem(provider, provider.repo, { lane: 'web', title: 'Provider work', criterion: 'Provider work is verified', check: 'true', specs: ['G1'], diagnose: false }).item_id;
  const consumerId = fileFixtureItem(consumer, consumer.repo, { lane: 'web', title: 'Waits on provider', criterion: 'Waits for provider verification', check: 'true', specs: ['G1'], diagnose: false, args: ['--after', `repo#${providerId}`] }).item_id;
  const blocked = consumer.run(consumer.web, 'claim', String(consumerId));
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(`${blocked.err}${blocked.out}`, new RegExp(`#${consumerId} waits on repo#${providerId}`, 'u'));

  const claimed = provider.run(provider.web, 'claim', String(providerId));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  mkdirSync(join(provider.web, 'web'), { recursive: true });
  writeFileSync(join(provider.web, 'web', 'provider.js'), 'export const provider = true;\n');
  provider.git(provider.web, 'add', 'web/provider.js');
  provider.git(provider.web, 'commit', '-q', '-m', 'feat(web): provider fixture [G1]');
  const submitted = provider.run(provider.web, 'submit', String(providerId), '--no-next');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const verified = provider.run(provider.repo, 'verify', String(providerId), 'accept', '--as', 'coordinator', '--note', 'the provider gate passed');
  assert.equal(verified.code, 0, verified.err + verified.out);

  const eligible = consumer.run(consumer.web, 'claim', String(consumerId));
  assert.equal(eligible.code, 0, eligible.err + eligible.out);
  assert.match(eligible.out, new RegExp(`claimed #${consumerId}`, 'u'));
});
