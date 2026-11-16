/** Accept a release only on a recorded receipt that binds the exact commit; no workflow or native custody changes here [C7,I15]. */
import { parseArgs } from 'node:util';
import { Refused } from '../../../../kernel/index.js';
import {
  releaseReceiptFields,
  releaseReceiptProblem,
} from './receipt.js';
import {
  ReleaseTransportError,
  latestGitHubReleaseRun,
  readGitHubReleaseReceipt,
} from './transport.js';

const DEFAULT_SERVICES = { releaseReceiptFields, releaseReceiptProblem, latestGitHubReleaseRun, readGitHubReleaseReceipt, ReleaseTransportError };

/**
 * Return the verified receipt for a repository and commit, or throw Refused naming why it is not accepted.
 * Why: the release workflow needs one yes/no answer that only a green, exact-commit, all-executor receipt can give.
 *
 * @param {string} root the checkout whose committed policy defines the accepted command
 * @param {{repository: string, head: string, runId?: string|number}} request
 * @param {{verifyHostedRelease: Function} & object} services the caller hands in the hosted verifier (gate may not import the sandbox cell) and any injected readers
 */
export async function acceptRelease(root, request, services = {}) {
  const all = { ...DEFAULT_SERVICES, ...services };
  try {
    if (typeof all.verifyHostedRelease !== 'function') throw new all.ReleaseTransportError('no hosted verifier was supplied');
    const result = await all.verifyHostedRelease(root, request, all);
    const { required, shards } = result.receipt.participation;
    if (!required.length || !shards.length || result.receipt.gateReceipt.green !== true) throw new all.ReleaseTransportError('receipt is not green for every required executor');
    return result;
  } catch (error) {
    const absent = error?.code === 'NO_RELEASE_RECEIPT';
    throw new Refused(absent ? 'RELEASE_NO_RECEIPT' : 'RELEASE_NOT_ACCEPTED',
      `the release for ${request?.head ?? 'this commit'} is not accepted: ${error?.message ?? 'receipt unreadable'}; run the release gate on this commit and publish its receipt, then accept again`);
  }
}

/**
 * The accept command: exit 0 only for an accepted receipt; any other state prints Refused(rule code, next step) and exits 1.
 *
 * @param {string} root
 * @param {string[]} argv `--repository owner/name --head <sha> [--run <id>]`
 * @param {{out?: (line: string) => void, err?: (line: string) => void, services?: object}} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function runAccept(root, argv, { out = line => console.log(line), err = line => console.error(line), services } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { repository: { type: 'string' }, head: { type: 'string' }, run: { type: 'string' } }, allowPositionals: false });
    const result = await acceptRelease(root, { repository: values.repository, head: values.head, runId: values.run }, services);
    out(`accepted release ${values.head}: ${result.receipt.participation.required.length} executors; GitHub run ${result.provenance.runId}`);
    return 0;
  } catch (error) {
    err(error instanceof Refused ? error.message : `[RELEASE_NOT_ACCEPTED] ${error?.message ?? 'bad arguments'}; pass --repository owner/name and --head <sha>`);
    return 1;
  }
}
