/** Authenticated relay API2 snapshot objects; stored data remains opaque to the relay [H15,H17]. */
import { createHash } from 'node:crypto';
import {
  apiJson,
  apiRefusal,
  apiStatus,
  readApiBody,
} from '../../../../packages/api/index.js';
import { refusalDocument } from '../../../cli/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import {
  PAGE_BYTES,
  PAGE_CIPHER_BYTES,
  PAGE_FANOUT,
  pageReference,
} from '../../../../packages/pages/index.js';

const PAGE_BODY_BYTES = 600_000;

/** Tell the host router that a response was completed, including refusals. */
function reply(res, status, value) { apiJson(res, status, value); return true; }

/** The journal's authenticated metadata points at the exact opaque root object, without decoding it. */
export function snapshotPageRoot(snapshot) {
  if (snapshot?.apiVersion !== 2) return null;
  return pageReference({ id: createHash('sha256').update(snapshot.bytes).digest('hex'), sequence: snapshot.sequence, bytes: snapshot.pageBytes });
}

/** Require an intentional API2 object, never an accidentally uploaded key or account field. */
function only(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new Refused('BAD_REQUEST', 'Send only the fields of this sealed-page operation; keep keys on the device.');
}

/** Decode canonical ciphertext transport without accepting a permissive base64 alias. */
function cipherBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Refused('BAD_PAGE', 'Send canonical base64url encrypted page bytes.');
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.byteLength || bytes.byteLength > PAGE_CIPHER_BYTES || bytes.toString('base64url') !== value) throw new Refused('BAD_PAGE', 'Send one bounded encrypted page under its content id.');
  return bytes;
}

/** Add the new snapshot transport without changing API1 native board documents or executable move formats. */
export function createRelayPagesHandler({ directory, now, authorize, withJournal, sender, quota, annotated, refreshStorage, enabled = true }) {
  /** Open objects only while the caller's shared board lifecycle lock and fresh authorization hold. */
  function withPages(id, who, work, create = false) {
    return withJournal(id, journal => {
      const pages = journal.pages({ now });
      try { return work(journal, pages); } finally { pages.close(); }
    }, create, who.engineVersion);
  }

  /** Preserve supported old heads while making paged heads explicit to new clients. */
  function head(journal, pages, principal, id) {
    const snapshot = journal.snapshot();
    if (!snapshot) throw new Refused('NO_SNAPSHOT', 'Upload a sealed snapshot before reading this board.');
    const root = snapshotPageRoot(snapshot);
    if (!root) return { ...annotated(snapshot, id), apiVersion: 1, storage: quota.usage(id) };
    const read = pages.pin(principal, root);
    const storage = quota.usage(id);
    const warning = quota.notice(id, storage);
    return { apiVersion: 2, sequence: snapshot.sequence, receivedAt: snapshot.receivedAt, sender: snapshot.sender,
      root, read, storage, ...(warning ? { warning } : {}) };
  }

  /** Route only bounded opaque operations; no request supplies the account charged for them. */
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return false; }
    if (!url.pathname.startsWith('/api/v2')) return false;
    try {
      if (req.method === 'GET' && url.pathname === '/api/v2') return reply(res, 200, enabled
        ? { apiVersion: 2, snapshot: 'sealed-pages', pageBytes: PAGE_BYTES, cipherBytes: PAGE_CIPHER_BYTES, fanout: PAGE_FANOUT }
        : { apiVersion: 1, snapshot: 'legacy' });
      if (!enabled) throw new Refused('RELAY_API_VERSION', 'Upgrade the relay authentication adapter to serve relay API version2.');
      const route = /^\/api\/v2\/boards\/([0-9a-f]{32})\/(state|storage|uploads(?:\/([A-Za-z0-9-]{1,128})(?:\/(publish|objects\/([0-9a-f]{64})))?)?|objects\/([0-9a-f]{64}))$/u.exec(url.pathname);
      if (!route) throw new Refused('BAD_REQUEST', 'Use a supported relay API version2 sealed-page route.');
      const id = route[1];
      const write = req.method !== 'GET';
      const who = await authorize(req, id, write);
      const principal = sender(who, write ? 'snapshot' : false);
      if (req.method === 'GET' && route[2] === 'storage') return reply(res, 200, { apiVersion: 2, ...refreshStorage(id, principal) });
      if (req.method === 'GET' && route[2] === 'state') {
        const state = withPages(id, who, (journal, pages) => head(journal, pages, principal, id));
        return reply(res, 200, { apiVersion: 2, state });
      }
      if (req.method === 'POST' && route[2] === 'uploads') {
        const body = await readApiBody(req);
        only(body, ['sequence', 'resume']);
        const result = withPages(id, who, (journal, pages) => {
          const current = snapshotPageRoot(journal.snapshot());
          pages.prune(current ? [current.id] : []);
          quota.usage(id, principal);
          const upload = body.resume ? pages.resume(body.resume, principal, body.sequence) : pages.begin(principal, body.sequence);
          return { upload, storage: quota.usage(id) };
        }, true);
        return reply(res, 200, { apiVersion: 2, ...result });
      }
      if (req.method === 'PUT' && route[5]) {
        const body = await readApiBody(req, { maxBytes: PAGE_BODY_BYTES });
        only(body, ['sequence', 'sealed', 'children']);
        const object = { id: route[5], sequence: body.sequence, bytes: cipherBytes(body.sealed), children: body.children };
        const stored = withPages(id, who, (journal, pages) => {
          const current = snapshotPageRoot(journal.snapshot());
          pages.prune(current ? [current.id] : []);
          return pages.put(route[3], principal, object, delta => quota.change(id, principal, delta, () => {}));
        });
        return reply(res, 200, { apiVersion: 2, page: stored });
      }
      if (req.method === 'POST' && route[4] === 'publish') {
        const body = await readApiBody(req);
        only(body, ['root', 'initialOnly', 'recovery']);
        const reference = pageReference(body.root);
        if (reference.bytes > PAGE_BYTES || body.initialOnly !== undefined && typeof body.initialOnly !== 'boolean' || body.recovery !== undefined && typeof body.recovery !== 'boolean') throw new Refused('BAD_PAGE', 'Publish a bounded sealed root for this upload.');
        const saved = withPages(id, who, (journal, pages) => {
          const snapshot = pages.publish(route[3], principal, reference, (root, bytes) => quota.change(id, principal, journal.snapshotDelta(root.sequence, bytes),
            () => journal.saveSnapshot(root.sequence, bytes, principal, { apiVersion: 2, pageBytes: root.bytes, initialOnly: body.initialOnly === true, recovery: body.recovery === true })));
          pages.prune([reference.id]);
          quota.clear(id);
          return { root: snapshotPageRoot(snapshot), sequence: snapshot.sequence, sender: snapshot.sender, ...(snapshot.epoch ? { epoch: snapshot.epoch } : {}), storage: quota.usage(id) };
        });
        return reply(res, 200, { apiVersion: 2, state: saved });
      }
      if (req.method === 'GET' && route[6]) {
        const via = url.searchParams.get('via') ?? '';
        if (via.length > 64 * 65) throw new Refused('BAD_PAGE_PATH', 'Use the bounded path from this pinned snapshot.');
        const object = withPages(id, who, (journal, pages) => pages.get(url.searchParams.get('pin'), principal, route[6], via ? via.split(',') : []));
        return reply(res, 200, { apiVersion: 2, page: { id: object.id, sequence: object.sequence, sealed: object.bytes.toString('base64url'), children: object.children } });
      }
      throw new Refused('BAD_REQUEST', 'Use the supported method for this sealed-page route.');
    } catch (error) {
      const document = apiRefusal(error, refusalDocument);
      if (error instanceof Refused && error.page && /^[0-9a-f]{64}$/u.test(error.page)) document.error.page = error.page;
      if (error instanceof Refused && error.storage) document.error.storage = error.storage;
      const status = { ACCOUNT_STORAGE_LIMIT: 507, BAD_PAGE_PATH: 403, SNAPSHOT_READ_EXPIRED: 410, SNAPSHOT_UPLOAD_EXPIRED: 410 }[error.code] ?? apiStatus(error);
      return reply(res, status, { ...document, apiVersion: 2 });
    }
  }
  return handle;
}
