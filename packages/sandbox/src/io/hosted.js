/** Hosted publication reads only an authenticated producer artifact, never a caller's local receipt file [C7,I15]. */
import {
  createHash,
} from 'node:crypto';
import {
  headCommit,
  tryGit,
} from '../../../git/index.js';
import {
  policyAt,
} from './trusted/policy/committed.js';

/** Bind authenticated artifact content to independently read tagged Git objects and accepted command policy. */
export function hostedReleaseFields(root, downloaded, { repository, head }, { releaseReceiptFields, releaseReceiptProblem, ReleaseTransportError }) {
  const provenance = downloaded?.provenance;
  if (provenance?.authenticatedTransport !== true || provenance.repository !== repository || provenance.head !== head
    || provenance.workflow !== '.github/workflows/release-gate.yml') throw new ReleaseTransportError('release evidence has no authenticated producer transport');
  if (headCommit(root) !== head) throw new ReleaseTransportError('release verifier checkout differs from the tagged commit');
  const tree = tryGit(root, ['rev-parse', '--verify', `${head}^{tree}`]);
  if (tree.status !== 0) throw new ReleaseTransportError('tagged release tree is unavailable');
  const expected = { head, tree: tree.stdout.trim(), command: createHash('sha256').update(policyAt(root, head).config.gate).digest('hex'),
    required: downloaded.envelope?.participation?.required };
  const problem = releaseReceiptProblem(downloaded.envelope, expected);
  if (problem) throw new ReleaseTransportError(`recorded release receipt refused: ${problem}`);
  return releaseReceiptFields(downloaded.envelope, expected);
}

/** Use the real authenticated GitHub transport; test injection never becomes production publishing authority. */
export async function verifyHostedRelease(root, { repository, head, runId }, services) {
  const { latestGitHubReleaseRun, readGitHubReleaseReceipt } = services;
  const selected = runId ?? latestGitHubReleaseRun({ repository, head });
  const downloaded = await readGitHubReleaseReceipt({ repository, head, runId: selected });
  return { receipt: hostedReleaseFields(root, downloaded, { repository, head }, services), provenance: downloaded.provenance };
}
