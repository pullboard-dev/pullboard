/** Board-authorized opaque upload notices; contents stay with the board's device keys [H5,H17]. */
import {
  apiJson,
  readApiBody,
} from '../../../../packages/api/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

/** Reuse the normal live board authorization and journal lifetime for this bounded metadata record. */
export function createUploadStatusHandler({ authorize, withJournal, sender }) {
  return async function uploadStatus(req, res, url) {
    const route = /^\/api\/v1\/boards\/([0-9a-f]{32})\/upload-status$/u.exec(url.pathname);
    if (!route) return false;
    if (url.search || !['GET', 'PUT'].includes(req.method)) throw new Refused('BAD_REQUEST', 'Read or replace this board’s sealed upload notice without URL parameters.');
    const id = route[1];
    const who = await authorize(req, id, req.method === 'PUT');
    if (req.method === 'PUT') {
      sender(who, 'snapshot');
      const body = await readApiBody(req, { maxBytes: 24_000 });
      if (!body || Object.keys(body).join(',') !== 'sealed' || typeof body.sealed !== 'string'
          || !/^[A-Za-z0-9_-]{39,21846}$/u.test(body.sealed)) throw new Refused('BAD_UPLOAD', 'Send only a bounded sealed upload notice.');
      const bytes = Buffer.from(body.sealed, 'base64url');
      if (bytes.toString('base64url') !== body.sealed) throw new Refused('BAD_UPLOAD', 'Send canonical sealed upload bytes.');
      const recorded = withJournal(id, journal => journal.saveUploadStatus(bytes), true, who.engineVersion);
      apiJson(res, 200, { recorded });
    } else {
      const bytes = withJournal(id, journal => journal.uploadStatus(), false, who.engineVersion);
      apiJson(res, 200, { status: bytes ? { sealed: Buffer.from(bytes).toString('base64url') } : null });
    }
    return true;
  };
}
