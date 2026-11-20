/** Synthetic server metadata and disposable archives only: no GitHub request, producer run or native proof is claimed. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  GitHubReleaseTransport,
  ReleaseTransportError,
  unpackReleaseReceipt,
} from '../../../../../../packages/gate/heavy.js';
import { verifyHostedRelease } from '../../../../../../packages/sandbox/index.js';
import { releaseReceiptFields } from '../../../../../../packages/gate/heavy.js';
import { releaseReceiptProblem } from '../../../../../../packages/gate/heavy.js';

/** Supply explicit synthetic API observations; the envelope remains intentionally unvalidated by this transport. */
function fixture() {
  const options = { repository: 'synthetic-owner/synthetic-repo', head: 'a'.repeat(40), runId: 12 };
  const repository = { id: 99, full_name: options.repository };
  const run = { id: 12, repository, head_repository: { ...repository }, head_sha: options.head, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', workflow_id: 13, run_attempt: 2, path: '.github/workflows/release-gate.yml@main' };
  const workflow = { id: 13, path: '.github/workflows/release-gate.yml' };
  const jobs = [{ id: 14, run_id: 12, head_sha: options.head, name: 'release-gate', status: 'completed', conclusion: 'success',
    labels: ['self-hosted', 'synthetic-runner'], started_at: '2026-10-27T10:00:00Z', completed_at: '2026-10-27T10:02:00Z' }];
  const artifacts = [{ id: 15, name: `pullboard-release-receipt-${options.head}`, expired: false, size_in_bytes: 500,
    workflow_run: { id: 12, repository_id: 99, head_repository_id: 99, head_sha: options.head, head_branch: 'main' },
    created_at: '2026-10-27T10:01:00Z', expires_at: '2026-11-27T10:00:00Z', digest: `sha256:${'b'.repeat(64)}` }];
  const calls = [];
  /** Route only known fixture paths so accidental endpoints cannot succeed silently. */
  const api = async (path, flags) => {
    calls.push({ path, flags });
    if (path.endsWith('/runs/12')) return structuredClone(run);
    if (path.endsWith('/workflows/13')) return structuredClone(workflow);
    if (path.endsWith('/runs/12/attempts/2/jobs?per_page=100&page=1')) return { total_count: jobs.length, jobs: structuredClone(jobs) };
    if (path.endsWith('/runs/12/artifacts?per_page=100&page=1')) return { total_count: artifacts.length, artifacts: structuredClone(artifacts) };
    if (path.endsWith('/artifacts/15/zip') && flags?.archive === true) return Buffer.from('synthetic archive seam');
    throw new Error('unexpected synthetic API path');
  };
  const envelope = { synthetic: true, structuralValidationRequired: true };
  const transport = new GitHubReleaseTransport({ api, authenticate: async () => {}, unpack: async () => envelope,
    now: () => Date.parse('2026-10-27T10:03:00Z') });
  return { options, run, workflow, jobs, artifacts, calls, envelope, transport };
}

/** Register metadata and archive boundary controls, without running an actual workflow or contacting GitHub. */
export function installReleaseTransportCases() {
  test('hosted verifier keeps selected run binding and refuses synthetic transport through explicit services [C7,V4]', async () => {
    for (const explicit of [false, true]) {
      const f = fixture();
      const selected = [];
      const reads = [];
      const services = {
        releaseReceiptFields, releaseReceiptProblem, ReleaseTransportError,
        latestGitHubReleaseRun: options => { selected.push(options); return f.options.runId; },
        readGitHubReleaseReceipt: async options => { reads.push(options); return f.transport.read(options); },
      };
      const { repository, head, runId } = f.options;
      await assert.rejects(() => verifyHostedRelease('/missing/synthetic-release-checkout',
        { repository, head, ...(explicit ? { runId } : {}) }, services), error =>
        error instanceof ReleaseTransportError && error.code === 'INVALID_RELEASE_RECEIPT'
        && error.message === 'release evidence has no authenticated producer transport');
      assert.deepEqual(selected, explicit ? [] : [{ repository, head }]);
      assert.deepEqual(reads, [{ repository, head, runId }]);
    }
  });

  test('synthetic hosted metadata binds exact main producer latest attempt and server artifact id [C7,V4]', async () => {
    const f = fixture();
    const result = await f.transport.read(f.options);
    assert.equal(result.envelope, f.envelope, 'transport deliberately leaves structural validation to its separate validator');
    assert.equal(result.provenance.repository, f.options.repository);
    assert.equal(result.provenance.artifactId, 15);
    assert.equal(result.provenance.producerJobId, 14);
    assert.equal(result.provenance.archiveDigestVerified, false);
    assert.equal(result.provenance.authenticatedTransport, false, 'injected metadata must never pretend to be production authentication');
    assert.equal(result.provenance.transport, 'injected-test');
    assert.ok(f.calls.some(call => call.path.endsWith('/attempts/2/jobs?per_page=100&page=1')));
    assert.ok(f.calls.some(call => call.path.endsWith('/artifacts/15/zip')));
    assert.ok(!f.calls.some(call => call.path.includes('archive_download_url')));
    f.run.event = 'workflow_dispatch';
    assert.equal((await f.transport.read(f.options)).provenance.head, f.options.head);
  });

  test('hosted release refuses wrong repository head event workflow job and stale artifact associations [C7,V4]', async () => {
    const mutations = [
      f => { f.run.repository.full_name = 'other/repo'; },
      f => { f.run.head_repository.full_name = 'fork/repo'; },
      f => { f.run.head_sha = 'c'.repeat(40); },
      f => { f.run.head_branch = 'feature'; },
      f => { f.run.event = 'pull_request'; },
      f => { f.run.conclusion = 'failure'; },
      f => { f.workflow.path = '.github/workflows/other.yml'; },
      f => { f.run.path = '.github/workflows/release-gate.yml@feature'; },
      f => { f.jobs[0].labels = ['ubuntu-latest']; },
      f => { f.jobs[0].conclusion = 'failure'; },
      f => { f.jobs.push({ ...f.jobs[0], id: 16, conclusion: 'failure' }); },
      f => { f.jobs[0].head_sha = 'c'.repeat(40); },
      f => { f.artifacts.length = 0; },
      f => { f.artifacts.push({ ...f.artifacts[0], id: 16 }); },
      f => { f.artifacts[0].expired = true; },
      f => { f.artifacts[0].workflow_run.head_sha = 'c'.repeat(40); },
      f => { f.artifacts[0].workflow_run.id = 13; },
      f => { f.artifacts[0].workflow_run.head_repository_id = 100; },
      f => { f.artifacts[0].size_in_bytes = 17 * 1024 * 1024; },
      f => { f.artifacts[0].created_at = '2026-10-27T09:00:00Z'; },
      f => { f.artifacts[0].expires_at = '2026-10-27T10:02:00Z'; },
      f => { f.artifacts[0].digest = 'not-a-digest'; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f);
      await assert.rejects(() => f.transport.read(f.options), error => error instanceof ReleaseTransportError && error.exitCode === 1);
    }
  });

  test('only absent producers yield no-receipt while invalid lookup and recognized red remain errors [C7,V4]', async () => {
    const absent = fixture();
    const missingRun = new GitHubReleaseTransport({ authenticate: async () => {}, api: async () => {
      throw new ReleaseTransportError('explicitly synthetic absent workflow run', true);
    } });
    await assert.rejects(() => missingRun.read(absent.options), error => error.exitCode === 3 && error.code === 'NO_RELEASE_RECEIPT');
    const missingJob = fixture(); missingJob.jobs.length = 0;
    await assert.rejects(() => missingJob.transport.read(missingJob.options), error => error.exitCode === 1);
    const pending = fixture(); pending.run.status = 'in_progress'; pending.run.conclusion = null;
    await assert.rejects(() => pending.transport.read(pending.options), error => error.exitCode === 1);
    const red = fixture(); red.run.conclusion = 'failure';
    await assert.rejects(() => red.transport.read(red.options), error => error.exitCode === 1);
    for (const patch of [{ repository: '../escape' }, { repository: 'owner/repo;bad' }, { head: 'bad' }, { runId: '../12' }, { runId: 0 }]) {
      const f = fixture();
      await assert.rejects(() => f.transport.read({ ...f.options, ...patch }), error => error.exitCode === 1);
      assert.equal(f.calls.length, 0, 'lookup validation precedes every API request');
    }
  });

  test('release archive reads exactly receipt.json to stdout and rejects foreign duplicate or oversized members [C7,V4]', t => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-synthetic-release-zip-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'receipt.json');
    writeFileSync(file, JSON.stringify({ explicitlySynthetic: true }));
    const archive = join(directory, 'one.zip');
    execFileSync('zip', ['-q', archive, 'receipt.json'], { cwd: directory, timeout: 15_000 });
    assert.deepEqual(unpackReleaseReceipt(readFileSync(archive)), { explicitlySynthetic: true });
    writeFileSync(join(directory, 'foreign.json'), '{}');
    execFileSync('zip', ['-q', archive, 'foreign.json'], { cwd: directory, timeout: 15_000 });
    assert.throws(() => unpackReleaseReceipt(readFileSync(archive)), error => error.exitCode === 1);
    assert.throws(() => unpackReleaseReceipt(Buffer.from('not a ZIP')), error => error.exitCode === 1);
    assert.throws(() => unpackReleaseReceipt(Buffer.alloc(17 * 1024 * 1024)), error => error.exitCode === 1);
    writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    const oversized = join(directory, 'oversized.zip');
    execFileSync('zip', ['-q', oversized, 'receipt.json'], { cwd: directory, timeout: 15_000 });
    assert.throws(() => unpackReleaseReceipt(readFileSync(oversized)), error => error.exitCode === 1);
  });
}
