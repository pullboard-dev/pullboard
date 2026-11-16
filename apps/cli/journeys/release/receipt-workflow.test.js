/** @pullboard-test-input .github/workflows/release.yml */
/** @pullboard-world-pin: the workflow text under test is the committed .github/workflows/release.yml. */
/** release.yml accepts the recorded gate receipt for the exact commit and refuses a receipt for any other [C7,I15]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runAccept } from '../../../../packages/gate/heavy.js';
import { releaseParticipationDigest } from '../../../../packages/gate/index.js';
import { ReleaseTransportError } from '../../../../packages/gate/index.js';
import { releaseReceiptFields } from '../../../../packages/gate/index.js';
import { releaseReceiptProblem } from '../../../../packages/gate/index.js';
import { verifyHostedRelease } from '../../../../packages/sandbox/index.js';
import { releaseReceiptFixture } from '../../tests/fixtures/release/cases/receipt.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';
import { policyAt } from '../../../../packages/sandbox/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const RELEASE = readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf8');
const REPOSITORY = 'example/project';
const WORKFLOW = '.github/workflows/release-gate.yml';

/** A real one-commit repository whose committed policy names the gate command the receipt must bind. */
function repository(t) {
  const root = temporaryRepository(t, 'pullboard-release-receipt-');
  const git = (...args) => runFixtureGit(args, { cwd: root });
  const head = git('rev-parse', 'HEAD');
  return { root, head, tree: git('rev-parse', 'HEAD^{tree}'), gate: policyAt(root, head).config.gate };
}

/** The structural fixture receipt re-bound to a real commit: heads, trees, command digest and the participation digest. */
function receiptFor({ head, tree, gate }) {
  const { envelope } = releaseReceiptFixture(1);
  const { gateReceipt, participation } = envelope;
  const command = createHash('sha256').update(gate).digest('hex');
  Object.assign(gateReceipt, { head, tree, main: head, command });
  Object.assign(participation, { head, tree, command });
  for (const shard of participation.shards) Object.assign(shard, { head, tree });
  gateReceipt.participationDigest = releaseParticipationDigest(participation);
  return envelope;
}

/** Run the accept command the workflow runs, with the recorded receipt served as authenticated for `recordedHead`. */
async function accept(root, { head, recorded, envelope }) {
  const lines = { out: [], err: [] };
  const services = {
    verifyHostedRelease, releaseReceiptFields, releaseReceiptProblem, ReleaseTransportError,
    latestGitHubReleaseRun: () => 12,
    readGitHubReleaseReceipt: async () => ({ envelope, provenance: { authenticatedTransport: true, repository: REPOSITORY, head: recorded, workflow: WORKFLOW, runId: 12 } }),
  };
  const code = await runAccept(root, ['--repository', REPOSITORY, '--head', head], { out: line => lines.out.push(line), err: line => lines.err.push(line), services });
  return { code, ...lines };
}

test('clause 1: release.yml accepts the recorded gate receipt for the exact commit and refuses a receipt for another commit [C7,I15]', async t => {
  assert.match(RELEASE, /id: receipt\n\s+continue-on-error: true\n[\s\S]*?run: node packages\/landing\/src\/io\/verify\/release\.js --repository "\$GITHUB_REPOSITORY" --head "\$GITHUB_SHA"/u,
    'the tag job asks the receipt verifier about the tagged commit itself');
  assert.match(RELEASE, /RECEIPT: \$\{\{ steps\.receipt\.outcome \}\}[\s\S]*?if \[ "\$RECEIPT" = success \]; then[\s\S]*?passed=true[\s\S]*?exit 0/u,
    'an accepted receipt is the same yes the publish steps already require');
  assert.ok(RELEASE.indexOf('id: receipt') < RELEASE.indexOf('id: main-ci') && RELEASE.indexOf('id: main-ci') < RELEASE.indexOf('run: npm publish'), 'the receipt is read before anything publishes');

  const { root, head, tree, gate } = repository(t);
  const good = await accept(root, { head, recorded: head, envelope: receiptFor({ head, tree, gate }) });
  assert.equal(good.code, 0, good.err.join('\n'));
  assert.match(good.out[0], new RegExp(`^accepted release ${head}`, 'u'));

  const other = 'c'.repeat(40);
  const wrongBinding = await accept(root, { head, recorded: head, envelope: receiptFor({ head: other, tree, gate }) });
  assert.equal(wrongBinding.code, 1, 'a receipt recorded for another commit is refused');
  assert.match(wrongBinding.err.join('\n'), /RELEASE_NOT_ACCEPTED/u);
  const wrongProvenance = await accept(root, { head, recorded: other, envelope: receiptFor({ head, tree, gate }) });
  assert.equal(wrongProvenance.code, 1, 'a receipt served for another commit is refused');
  assert.match(wrongProvenance.err.join('\n'), /RELEASE_NOT_ACCEPTED/u);
  const wrongCheckout = await accept(root, { head: other, recorded: other, envelope: receiptFor({ head: other, tree, gate }) });
  assert.equal(wrongCheckout.code, 1, 'a receipt for a commit that is not the checkout is refused');
  assert.match(wrongCheckout.err.join('\n'), /differs from the tagged commit/u);
});
