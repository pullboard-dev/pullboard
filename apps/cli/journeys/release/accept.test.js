/** The accept command exits 0 only for a green recorded receipt that binds the exact commit and every required executor [C7,I15]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ReleaseTransportError,
  releaseParticipationDigest,
} from '../../../../packages/gate/index.js';
import { runAccept } from '../../../../packages/gate/heavy.js';
import { verifyHostedRelease } from '../../../../packages/sandbox/index.js';

const ROOT = join(fileURLToPath(import.meta.url), '../../../../..');
const REPOSITORY = 'synthetic-owner/synthetic-repo';

/** Hash text the way the native gate hashes its command and collection. */
function digest(text) { return createHash('sha256').update(text).digest('hex'); }

/** Read one trimmed git answer from this checkout. */
function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

/** The commit this checkout is at, with the binding a real release receipt must carry. */
function source() {
  const head = git('rev-parse', 'HEAD');
  const gate = JSON.parse(git('show', `${head}:pullboard.json`)).gate;
  return { head, tree: git('rev-parse', `${head}^{tree}`), command: digest(gate) };
}

/** A synthetic complete receipt for `commit`, with one shard per executor; it claims no native run. */
function envelopeFor(commit, count = 3) {
  const required = Array.from({ length: count }, (_, i) => `synthetic-executor-${i + 1}`);
  const files = required.map((_, i) => `test/synthetic-${i + 1}.test.js`).sort();
  const id = '6af8c70a-65f0-4a61-8040-3f1f278d9a10';
  const gateReceipt = { version: 1, id: 'ff6e3e7b-df07-4ff1-a84f-378aeb883705', kind: 'release',
    head: commit.head, tree: commit.tree, main: commit.head, command: commit.command,
    green: true, failures: [], load: { average: [0, 0, 0], cpus: 8, freeMB: 4096 }, at: '2026-10-27T10:01:00.000Z',
    collection: { version: 1, mode: 'all', batchId: id, full: true, complete: true, files,
      plannedFiles: files.length, completedFiles: files.length, planDigest: digest(JSON.stringify(files)), completedDigest: digest(JSON.stringify(files)) } };
  const participation = { version: 1, id, head: commit.head, tree: commit.tree, command: commit.command, required,
    shards: files.map((file, i) => ({ shard: `synthetic-shard-${i + 1}`, files: [file], executor: required[i],
      head: commit.head, tree: commit.tree, command: digest(`synthetic shard ${file}`), green: true, complete: true, cleanupVerified: true })),
    startedAt: '2026-10-27T10:00:00.000Z', finishedAt: '2026-10-27T10:02:00.000Z' };
  gateReceipt.participationDigest = releaseParticipationDigest(participation);
  return { version: 1, gateReceipt, participation };
}

/** Run accept against a synthetic reader for `head`; the reader returns `envelope` as authenticated evidence. */
async function accept(head, envelope, read) {
  const lines = { out: [], err: [] };
  const services = {
    verifyHostedRelease,
    latestGitHubReleaseRun: () => 12,
    readGitHubReleaseReceipt: read ?? (async options => {
      if (!envelope) throw new ReleaseTransportError('GitHub release producer was not found', true);
      return { envelope, provenance: { authenticatedTransport: true, repository: REPOSITORY, head: options.head,
        workflow: '.github/workflows/release-gate.yml', runId: 12, artifactId: 15 } };
    }),
  };
  const code = await runAccept(ROOT, ['--repository', REPOSITORY, '--head', head],
    { out: line => lines.out.push(line), err: line => lines.err.push(line), services });
  return { code, ...lines };
}

test('clause 1: the receipt for the exact commit is accepted [C7,I15]', async () => {
  const commit = source();
  const result = await accept(commit.head, envelopeFor(commit));
  assert.equal(result.code, 0);
  assert.match(result.out.join('\n'), /accepted release .* 3 executors/u);
  assert.deepEqual(result.err, []);
});

test('clause 2: a receipt for another commit is refused [C7,I15]', async () => {
  const commit = source();
  const other = { ...commit, head: 'c'.repeat(40) };
  const result = await accept(commit.head, envelopeFor(other));
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /^\[RELEASE_NOT_ACCEPTED\] .*run the release gate/u);
  assert.deepEqual(result.out, []);
});

test('clause 3: a missing receipt is refused with its own rule code [C7,I15]', async () => {
  const result = await accept(source().head, null);
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /^\[RELEASE_NO_RECEIPT\]/u);
});

test('clause 4: a red or tampered receipt is refused [C7,I15]', async () => {
  const commit = source();
  const mutations = [
    e => { e.gateReceipt.green = false; },
    e => { e.participation.shards.pop(); },
    e => { e.participation.required.pop(); },
    e => { e.participation.shards[0].green = false; },
    e => { e.gateReceipt.participationDigest = '0'.repeat(64); },
    e => { e.gateReceipt.command = digest('another gate'); },
    e => { e.authority = 'invented'; },
  ];
  for (const mutate of mutations) {
    const envelope = envelopeFor(commit);
    mutate(envelope);
    const result = await accept(commit.head, envelope);
    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /^\[RELEASE_NOT_ACCEPTED\]/u);
  }
});

test('clause 5: evidence that is not authenticated or unreadable is refused [C7,I15]', async () => {
  const commit = source();
  const unauthenticated = await accept(commit.head, null, async options => ({ envelope: envelopeFor(commit),
    provenance: { authenticatedTransport: false, repository: REPOSITORY, head: options.head, workflow: '.github/workflows/release-gate.yml' } }));
  assert.equal(unauthenticated.code, 1);
  const broken = await accept(commit.head, null, async () => { throw new Error('network down'); });
  assert.equal(broken.code, 1);
  const noArguments = await runAccept(ROOT, [], { out() {}, err() {}, services: { verifyHostedRelease } });
  assert.equal(noArguments, 1);
});
