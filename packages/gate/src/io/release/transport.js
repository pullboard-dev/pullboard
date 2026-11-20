/** Authenticated GitHub transport, separate from structural validation and native gate custody [C7,V4]. */
import {
  execFileSync,
} from 'node:child_process';
import { scratchFolder } from '../../../../config/index.js';
import {
  join,
} from 'node:path';
import {
  RELEASE_RECEIPT_MAX_BYTES,
} from './receipt.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fs = fileSystemAdapter();

const WORKFLOW = '.github/workflows/release-gate.yml';
const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;

/** Distinguish an absent producer from invalid/red evidence without exposing credentials or raw process errors. */
export class ReleaseTransportError extends Error {
  /** Store a stable public failure classification; only absent producers permit the caller's old-CI fallback. */
  constructor(message, absent = false) {
    super(message);
    this.name = 'ReleaseTransportError';
    this.code = absent ? 'NO_RELEASE_RECEIPT' : 'INVALID_RELEASE_RECEIPT';
    this.exitCode = absent ? 3 : 1;
  }
}

/** Refuse malformed server evidence; this helper never silently converts failure into absence. */
function requireValue(condition, message) {
  if (!condition) throw new ReleaseTransportError(message);
}

/** Require positive safe server identifiers before using them in an API path. */
function serverId(value) { return Number.isSafeInteger(value) && value > 0; }

/** Validate public lookup arguments before authentication, networking or temporary-file allocation. */
function lookup(options) {
  const { repository, head, runId } = options ?? {};
  const parts = typeof repository === 'string' ? repository.split('/') : [];
  requireValue(parts.length === 2 && parts.every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(part)), 'invalid release repository');
  requireValue(typeof head === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head), 'invalid release head');
  const id = typeof runId === 'string' && /^[1-9][0-9]*$/u.test(runId) ? Number(runId) : runId;
  requireValue(serverId(id), 'invalid release workflow run id');
  return { repository, head, runId: id };
}

/** Run gh with a bounded captured response; raw stderr may contain private context and is never propagated. */
function gh(args, maxBuffer = MAX_JSON) {
  try { return execFileSync('gh', args, { timeout: 60_000, maxBuffer, encoding: null, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const absent = /\bHTTP 404\b/u.test(String(error.stderr ?? ''));
    throw new ReleaseTransportError(absent ? 'GitHub release producer was not found' : 'authenticated GitHub release request failed', absent);
  }
}

/** Verify the active github.com authentication without printing account or token diagnostics. */
function authenticate() { gh(['auth', 'status', '--hostname', 'github.com']); }

/** Fetch only the fixed GitHub API host; server download URLs never become arbitrary local commands. */
function api(path, { archive = false } = {}) {
  const bytes = gh(['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', path], archive ? MAX_ARCHIVE : MAX_JSON);
  if (archive) return bytes;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new ReleaseTransportError('GitHub returned malformed release metadata'); }
}

/** Read one bounded ZIP member to stdout only; no path from the archive is extracted to disk. */
export function unpackReleaseReceipt(bytes) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARCHIVE, 'invalid release artifact archive size');
  const directory = scratchFolder('pullboard-release-artifact-');
  try {
    const file = join(directory, 'artifact.zip');
    fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    const entries = execFileSync('unzip', ['-Z', '-1', file], { timeout: 15_000, maxBuffer: 16_384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    requireValue(entries === 'receipt.json\n', 'release archive must contain exactly receipt.json');
    const body = execFileSync('unzip', ['-p', file, 'receipt.json'], { timeout: 15_000,
      maxBuffer: RELEASE_RECEIPT_MAX_BYTES, encoding: null, stdio: ['ignore', 'pipe', 'pipe'] });
    requireValue(body.length > 0 && body.length <= RELEASE_RECEIPT_MAX_BYTES, 'invalid release receipt size');
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    if (error instanceof ReleaseTransportError) throw error;
    throw new ReleaseTransportError('release archive is invalid or exceeds extraction bounds');
  } finally { fs.rm(directory, { recursive: true, force: true }); }
}

/** Read every bounded page so duplicates outside the first page cannot evade exact-name checks. */
async function pages(apiCall, path, key) {
  const all = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const value = await apiCall(`${path}?per_page=100&page=${page}`);
    requireValue(value && Number.isSafeInteger(value.total_count) && value.total_count >= 0 && value.total_count <= 1000
      && Array.isArray(value[key]) && value[key].length <= 100, 'invalid or oversized GitHub release listing');
    total ??= value.total_count;
    requireValue(total === value.total_count, 'GitHub release listing changed during collection');
    all.push(...value[key]);
    if (all.length === total) return all;
    requireValue(all.length < total && value[key].length > 0, 'incomplete GitHub release listing');
  }
  throw new ReleaseTransportError('GitHub release listing exceeds page bound');
}

/** Require the exact hosted producer, main branch and head before trusting any artifact association. */
function validateRun(run, workflow, expected) {
  requireValue(run?.id === expected.runId && run.repository?.full_name === expected.repository
    && run.head_repository?.full_name === expected.repository && serverId(run.repository?.id)
    && run.head_repository?.id === run.repository.id && run.head_sha === expected.head && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event), 'workflow run does not bind the requested main head');
  requireValue(workflow?.id === run.workflow_id && [WORKFLOW, `${WORKFLOW}@main`].includes(workflow.path)
    && [WORKFLOW, `${WORKFLOW}@main`].includes(run.path), 'unexpected release workflow path');
  if (run.status !== 'completed') throw new ReleaseTransportError('release producer has not completed');
  requireValue(run.conclusion === 'success', 'release workflow did not succeed');
}

/** Require the latest matching producer job from the run's latest attempt, including actual self-hosted standing. */
function producerJob(jobs, run) {
  const matching = jobs.filter(job => job?.name === 'release-gate');
  if (!matching.length) throw new ReleaseTransportError('recognized release workflow has no producer job');
  requireValue(matching.every(job => serverId(job.id)), 'invalid release producer job id');
  const job = matching.sort((a, b) => b.id - a.id)[0];
  requireValue(job.run_id === run.id && job.head_sha === run.head_sha && job.status === 'completed' && job.conclusion === 'success'
    && Array.isArray(job.labels) && job.labels.includes('self-hosted'), 'latest release producer job failed or is not self-hosted');
  const start = Date.parse(job.started_at), finish = Date.parse(job.completed_at);
  requireValue(Number.isFinite(start) && Number.isFinite(finish) && start <= finish, 'invalid release producer job dates');
  return job;
}

/** Bind an unexpired unique artifact to this exact run, repository, head and latest producer interval. */
function artifactFor(artifacts, expected, run, job, now) {
  const matches = artifacts.filter(artifact => artifact?.name === `pullboard-release-receipt-${expected.head}`);
  requireValue(matches.length === 1, 'release producer must publish exactly one named receipt artifact');
  const artifact = matches[0], owner = artifact.workflow_run;
  requireValue(serverId(artifact.id) && artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARCHIVE
    && owner?.id === run.id && owner.repository_id === run.repository.id && owner.head_repository_id === run.repository.id
    && owner.head_sha === expected.head && owner.head_branch === 'main', 'release artifact does not bind the completed producer');
  const created = Date.parse(artifact.created_at), expires = Date.parse(artifact.expires_at);
  requireValue(Number.isFinite(created) && Number.isFinite(expires) && expires > now
    && created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at), 'release artifact is expired or belongs to an earlier producer attempt');
  requireValue(artifact.digest === undefined || artifact.digest === null || /^sha256:[a-f0-9]{64}$/u.test(artifact.digest), 'invalid server artifact digest');
  return artifact;
}

/** Injectable authenticated API boundary; fixtures exercise metadata without claiming live GitHub or native custody. */
export class GitHubReleaseTransport {
  /** Inject explicit fixture API/unpacking only in tests; production defaults authenticate and download through gh. */
  constructor({ api: apiCall = api, authenticate: auth = authenticate, unpack = unpackReleaseReceipt, now = () => Date.now() } = {}) {
    this.api = apiCall; this.authenticate = auth; this.unpack = unpack; this.now = now;
    this.production = apiCall === api && auth === authenticate && unpack === unpackReleaseReceipt;
  }

  /** Fetch authenticated metadata and artifact bytes; the caller must separately validate the envelope's structure. */
  async read(options) {
    const expected = lookup(options);
    await this.authenticate();
    const base = `repos/${expected.repository}/actions`;
    const run = await this.api(`${base}/runs/${expected.runId}`);
    requireValue(serverId(run?.workflow_id) && serverId(run?.run_attempt), 'invalid workflow metadata identity');
    /** Missing metadata after a run exists is invalid evidence, not permission for old-CI fallback. */
    const metadata = async path => {
      try { return await this.api(path); }
      catch { throw new ReleaseTransportError('required release producer metadata could not be read'); }
    };
    const workflow = await metadata(`${base}/workflows/${run.workflow_id}`);
    validateRun(run, workflow, expected);
    const jobs = await pages(metadata, `${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    const job = producerJob(jobs, run);
    const artifacts = await pages(metadata, `${base}/runs/${run.id}/artifacts`, 'artifacts');
    const artifact = artifactFor(artifacts, expected, run, job, this.now());
    let bytes;
    try { bytes = await this.api(`${base}/artifacts/${artifact.id}/zip`, { archive: true }); }
    catch { throw new ReleaseTransportError('recognized release producer artifact could not be downloaded'); }
    requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARCHIVE, 'invalid downloaded release archive size');
    const envelope = await this.unpack(bytes);
    return { envelope, provenance: { repository: expected.repository, runId: run.id, artifactId: artifact.id,
      head: expected.head, workflow: WORKFLOW, producerJobId: job.id, authenticatedTransport: this.production, transport: this.production ? 'github-authenticated' : 'injected-test',
      artifactDigest: artifact.digest ?? null, archiveDigestVerified: false,
      digestQualification: 'GitHub REST documents an artifact digest, not a guarantee that it hashes these downloaded ZIP bytes.' } };
  }
}

/** Production authenticated hosted reader; this function never writes a native receipt or changes release settings. */
export function readGitHubReleaseReceipt(options) { return new GitHubReleaseTransport().read(options); }

/** Find the newest exact-head producer; a failed or pending producer is returned rather than skipped for an older green one. */
export function latestGitHubReleaseRun({ repository, head }) {
  lookup({ repository, head, runId: 1 });
  authenticate();
  const value = api(`repos/${repository}/actions/workflows/release-gate.yml/runs?branch=main&head_sha=${head}&per_page=1`);
  requireValue(Number.isSafeInteger(value?.total_count) && Array.isArray(value.workflow_runs), 'invalid release workflow listing');
  if (value.total_count === 0 && value.workflow_runs.length === 0) throw new ReleaseTransportError('no release producer for this commit', true);
  requireValue(value.workflow_runs.length === 1 && serverId(value.workflow_runs[0]?.id), 'invalid latest release producer identity');
  return value.workflow_runs[0].id;
}
