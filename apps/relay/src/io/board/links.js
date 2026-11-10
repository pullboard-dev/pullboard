/** Authenticated cross-board dispatch shares existing relay credentials and opaque storage [E32,H16,H17]. */
import { closeSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/index.js';
import { apiJson } from '../../../../../packages/api/index.js';
import { readApiBody } from '../../../../../packages/api/index.js';
import { openBoard } from '../../../../lib/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { atomic } from '../../../../../packages/store/index.js';
import { readBoardLinks } from '../../../../../packages/store/index.js';
import { verifyBoardLink } from '../../../../../packages/store/index.js';
import { commitVerifiedBoardLink } from '../../../../../packages/store/index.js';
import { boardReferenceId } from '../../../../../packages/kernel/index.js';
import { boardLinkName } from '../../../../../packages/kernel/index.js';
import { boardLinkEnvelope } from '../../../../../packages/store/index.js';
import { appendBoardLinkEnvelope } from './inbox.js';
import { readBoardLinkEnvelopes } from './inbox.js';

/** Create one private authoritative DAG catalog without deriving any paths from message fields. */
function catalogBoard(directory, now) {
  const file = join(directory, 'board-links.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Refused('RELAY_STORAGE', 'keep the board-link catalog in a private regular database');
  return openBoard(file, { now: () => new Date(now()) }, { writeContext: { command: 'relay board-link catalog', seat: 'relay' } });
}

/** Refuse stale, reversed or revoked delivery before it reaches a recipient's opaque inbox. */
function currentLink(catalog, envelope) {
  const record = readBoardLinks(catalog).find(row => row.linkId === envelope.linkId);
  if (!record || record.revocation || record.generation !== envelope.generation
    || record.child.boardId !== envelope.sourceBoardId || record.parent.boardId !== envelope.destinationBoardId) {
    throw new Refused('BOARD_LINK_INACTIVE', 'use the current consenting child-to-parent link generation');
  }
  return record;
}

/**
 * Attach only the common link boundary. Existing authorization owns credentials, origins, engine
 * floors and expiry; existing journal lifecycle, backups, retention and quota own opaque payloads.
 */
export function createRelayBoardLinks({ directory, authority, authorize, auth, withJournal, store, now }) {
  const catalog = catalogBoard(directory, now);
  let closed = false;
  /** Stop an awaited authority/provider result from using a catalog closed during shutdown. */
  function open() { if (closed) throw new Refused('RELAY_CLOSED', 'open the relay link dispatcher before using it'); }
  return {
    /** Handle only narrow bilateral-consent and incoming-envelope endpoints. */
    async handle(req, res, url) {
      const link = /^\/api\/v1\/boards\/([^/]+)\/links(?:\/([^/]+))?$/u.exec(url.pathname);
      const deliveries = /^\/api\/v1\/boards\/([^/]+)\/link-deliveries$/u.exec(url.pathname);
      if (!link && !deliveries) return false;
      open();
      const id = boardReferenceId((link ?? deliveries)[1]);
      if (link && req.method === 'PUT' && link[2]) {
        const body = await readApiBody(req);
        if (Object.keys(body).join(',') !== 'record') throw new Refused('BOARD_LINK_FORMAT', 'send exactly one signed link record');
        const record = await verifyBoardLink(body.record, authority);
        if (record.linkId !== boardLinkName(link[2]) || ![record.parent.boardId, record.child.boardId].includes(id)) {
          throw new Refused('BOARD_LINK_AUTH', 'publish consent through one of its exact endpoint boards');
        }
        await authorize(req, id, true); // Last awaited operation before committing under lifecycle locks.
        open();
        const result = auth.withBoard(id, () => commitVerifiedBoardLink(catalog, record));
        apiJson(res, 200, { link: result });
        return true;
      }
      if (link && req.method === 'GET' && !link[2]) {
        await authorize(req, id);
        open();
        const records = readBoardLinks(catalog).filter(row => [row.parent.boardId, row.child.boardId].includes(id));
        apiJson(res, 200, { links: records });
        return true;
      }
      if (deliveries && req.method === 'POST') {
        const envelope = boardLinkEnvelope(await readApiBody(req));
        if (envelope.destinationBoardId !== id) throw new Refused('BOARD_LINK_AUTH', 'send the envelope to its exact receiving board');
        const record = currentLink(catalog, envelope);
        await verifyBoardLink(record, authority);
        // Authenticate the claimed SOURCE with the existing board-bound credential. A destination
        // path or another board's token cannot assert that identity. No provider await holds SQLite.
        const who = await authorize(req, envelope.sourceBoardId, true);
        open();
        const receipt = auth.withBoard(id, () => atomic(catalog, () => {
          if (JSON.stringify(currentLink(catalog, envelope)) !== JSON.stringify(record)) {
            throw new Refused('BOARD_LINK_CONFLICT', 'retry after consent changed during authorization');
          }
          return withJournal(id, () => appendBoardLinkEnvelope(join(directory, id + '.journal.sqlite'), envelope,
            { now, store: (delta, write) => store(id, { userId: who.user.id }, delta, write) }), false, who.engineVersion);
        }));
        apiJson(res, 200, { receipt });
        return true;
      }
      if (deliveries && req.method === 'GET') {
        const raw = url.searchParams.get('after') ?? '0';
        if (!/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Refused('BOARD_LINK_TRANSPORT', 'use a nonnegative incoming delivery cursor');
        const who = await authorize(req, id);
        open();
        const rows = withJournal(id, () => readBoardLinkEnvelopes(join(directory, id + '.journal.sqlite'), Number(raw)), false, who.engineVersion);
        apiJson(res, 200, { deliveries: rows });
        return true;
      }
      throw new Refused('BOARD_LINK_TRANSPORT', 'use PUT for consent, POST for sealed delivery, and GET for this board’s incoming page');
    },
    /** Close exactly the catalog connection owned by this dispatcher. */
    close() { if (!closed) { closed = true; closeBoard(catalog); } },
  };
}
