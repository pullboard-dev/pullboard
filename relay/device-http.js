/** Person-authorized account device enrollment and opaque key delivery [H5,H15,H17]. */
import { apiJson, apiRefusal, apiStatus, readApiBody } from '../src/api-http.js';
import { Refused } from '../src/refused.js';
import { devicePublicKey } from '../src/relay-device-keys.js';

/** Require exact bounded action fields, excluding secrets and unrecognized relay metadata. */
function exact(value, fields) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Refused('BAD_REQUEST', 'Send only the documented device action fields.');
  }
  return value;
}

/** Route only fixed device endpoints; ownership always comes from the authenticated session. */
export function createDeviceHandler({ authenticate, authorizeBoard, boardsFor, devices }) {
  return async function handleDevice(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/devices')) return false;
    try {
      if (url.search) throw new Refused('BAD_REQUEST', 'Keep device action fields out of URL queries.');
      const who = await authenticate(req, !['GET', 'HEAD'].includes(req.method));
      if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'Sign in as a person to pair or revoke a device.');
      const account = who.user.id;
      if (url.pathname === '/api/v1/devices/session' && req.method === 'GET') {
        apiJson(res, 200, { account }); return true;
      }
      const enrollment = /^\/api\/v1\/devices\/enrollments\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
      if (enrollment) {
        const locator = enrollment[1];
        if (req.method === 'GET') { apiJson(res, 200, devices.enrollment(account, locator)); return true; }
        if (req.method === 'POST') {
          exact(await readApiBody(req), []);
          devices.begin(account, locator);
        } else if (req.method === 'PUT') {
          const body = exact(await readApiBody(req, { maxBytes: 4096 }), ['v', 'account', 'locator', 'deviceId', 'publicKey', 'label', 'createdAt', 'mac']);
          if (body.v !== 1 || body.account !== account || body.locator !== locator || !/^device-[0-9a-f]{32}$/u.test(body.deviceId ?? '') ||
              !/^[A-Za-z0-9_-]{43}$/u.test(body.mac ?? '') || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 ||
              typeof body.createdAt !== 'string' || !Number.isFinite(Date.parse(body.createdAt))) {
            throw new Refused('DEVICE_ENROLLMENT', 'Pair with a fresh link signed in to the same account as the Mac.');
          }
          devicePublicKey(body.publicKey);
          devices.enroll(account, locator, body);
        } else if (req.method === 'DELETE') devices.consume(account, locator);
        else throw new Refused('NO_ENDPOINT', 'Use the supported device enrollment action.');
        apiJson(res, 200, { recorded: true }); return true;
      }
      const route = /^\/api\/v1\/devices\/(device-[0-9a-f]{32})(?:\/boards(?:\/([0-9a-f]{32}))?)?$/.exec(url.pathname);
      if (!route) throw new Refused('NO_ENDPOINT', 'Use a valid paired device id.');
      const [, id, board] = route;
      if (url.pathname.endsWith('/boards') && req.method === 'GET') {
        const visible = new Set((await boardsFor(req)).map(value => value.id));
        apiJson(res, 200, { wraps: devices.wraps(account, id).filter(value => visible.has(value.board)) }); return true;
      }
      if (board && req.method === 'PUT') {
        const principal = await authorizeBoard(req, board);
        if (principal.kind !== 'session' || principal.user.id !== account) throw new Refused('HUMAN_REQUIRED', 'Use the board owner session.');
        const body = exact(await readApiBody(req, { maxBytes: 8192 }), ['engine', 'wrapped']);
        if (!Number.isSafeInteger(body.engine) || body.engine < 1 || typeof body.wrapped !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/u.test(body.wrapped)) {
          throw new Refused('DEVICE_WRAP', 'Send a versioned client-encrypted device wrap.');
        }
        const bytes = Buffer.from(body.wrapped, 'base64url');
        if (bytes.toString('base64url') !== body.wrapped) throw new Refused('DEVICE_WRAP', 'Send canonical opaque transport bytes.');
        devices.put(account, id, board, body.engine, body.wrapped);
      } else if (!url.pathname.endsWith('/boards') && !board && req.method === 'POST') {
        exact(await readApiBody(req), []); devices.register(account, id);
      } else if (!url.pathname.endsWith('/boards') && !board && req.method === 'DELETE') devices.revoke(account, id);
      else throw new Refused('NO_ENDPOINT', 'Use the supported device action.');
      apiJson(res, 200, { recorded: true }); return true;
    } catch (error) { apiJson(res, apiStatus(error), apiRefusal(error)); return true; }
  };
}
