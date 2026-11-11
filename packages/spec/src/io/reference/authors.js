/** Bind explicit GitHub acknowledgements to source authors without executing referenced content [C7]. */
import { handledReferences } from './lines.js';
import { validateReferenceTargets } from './lines.js';
import { Refused } from '../../../../kernel/index.js';

/** Validate typed targets and the public acknowledgement's authority and source in one ordered move. */
export function validateReferences(brief, { actor, authors, authority, previous = '' }) {
  validateReferenceTargets(brief);
  validateReferenceAuthority(actor, brief, authority, previous);
  validateReferenceAuthors(brief, authors);
}

/** Changing a handled target or handle is a new public acknowledgement; retaining one is ordinary triage. */
function newAcknowledgements(brief, previous = '') {
  const old = new Set(handledReferences(previous).map(reference => JSON.stringify([reference.target, reference.handle.toLowerCase()])));
  return handledReferences(brief).some(reference => !old.has(JSON.stringify([reference.target, reference.handle.toLowerCase()])));
}

/** Authorize public acknowledgement through the same authenticated person channels as outside approval. */
export function referenceAuthority(ctx, actor, brief, previous = '', { requirePersonChannel } = {}) {
  if (!newAcknowledgements(brief, previous)) return undefined;
  if (ctx.io.personRequest?.phase !== 'execute') requirePersonChannel(ctx.io.personChannel);
  if (!ctx.info.isMain || actor !== 'coordinator') throw new Refused('B26_PERSON_CHANNEL', 'the person acknowledges an outside reference from the main checkout or its authenticated view; leave the reference unhandled for triage.');
  return 'person';
}

/** Replay person acknowledgement authority without consulting another device's shell. */
export function validateReferenceAuthority(actor, brief, authority, previous = '') {
  if (!newAcknowledgements(brief, previous)) return;
  if (!['coordinator', 'person'].includes(actor) || authority !== 'person') {
    throw new Refused('B26_PERSON_CHANNEL', 'only the authenticated person marks an outside reference handled; keep it without a handle for ordinary triage.');
  }
}

/** Recognize only a fixed GitHub issue or PR route; arbitrary references never become fetch URLs. */
function githubReference(target) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)\/?(?:[?#].*)?$/u.exec(target);
  if (!match || [match[1], match[2]].some(part => ['.', '..'].includes(part)) || !Number.isSafeInteger(Number(match[4]))) return null;
  return { repository: `${match[1]}/${match[2]}`, kind: match[3], number: Number(match[4]) };
}

/** Fetch only handled issue/PR authors and carry their checked identity in the same ordered move. */
export function referenceAuthors(root, brief, { githubPullClient } = {}) {
  return handledReferences(brief).flatMap(reference => {
    const source = githubReference(reference.target);
    if (!source) return [];
    const client = githubPullClient(root, source.repository);
    const data = source.kind === 'issues' ? client.readIssue(source.number) : client.read(source.number);
    const author = data?.user?.login;
    if (typeof author !== 'string' || author.toLowerCase() !== reference.handle.toLowerCase()) {
      throw new Refused('REFERENCE_AUTHOR', `${reference.target} was authored by ${author ? `@${author}` : 'an unknown author'}, not @${reference.handle}; use the source author or remove the handle.`);
    }
    return [{ target: reference.target, author }];
  });
}

/** Replay the coordinator's author attestation deterministically, without making network requests. */
export function validateReferenceAuthors(brief, authors = []) {
  const required = handledReferences(brief).filter(reference => githubReference(reference.target));
  if (!Array.isArray(authors) || authors.length !== required.length || required.some((reference, index) =>
    authors[index]?.target !== reference.target || typeof authors[index]?.author !== 'string'
      || authors[index].author.toLowerCase() !== reference.handle.toLowerCase())) {
    throw new Refused('REFERENCE_AUTHOR', 'handled GitHub references need matching source author attestations; use pullboard add or edit to read the issue or PR author, or remove the handle.');
  }
}
