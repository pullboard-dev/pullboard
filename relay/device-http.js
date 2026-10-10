/** Person-authorized account device enrollment and opaque key delivery [H5,H15,H17]. */
import { apiJson, apiRefusal, apiStatus, readApiBody } from '../src/api-http.js';
import { Refused } from '../src/refused.js';
import { devicePublicKey } from '../src/relay-device-keys.js';
import { approvalContext } from '../src/relay-approval.js';

/** Require exact bounded action fields, excluding secrets and unrecognized relay metadata. */
function exact(value, fields) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Refused('BAD_REQUEST', 'Send only the documented device action fields.');
  }
  return value;
}

/** Route only fixed device endpoints; ownership always comes from the authenticated session. */
export function createDeviceHandler({ authenticate, authorizeBoard, boardsFor, devices, linkBoard, issueMachine,
  issueActionGrant, consumeActionGrant, revokeToken, deleteBoard }) {
  return async function handleDevice(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/devices')) return false;
    try {
      if (url.search) throw new Refused('BAD_REQUEST', 'Keep device action fields out of URL queries.');
      const who = await authenticate(req, !['GET', 'HEAD'].includes(req.method));
      const account = who.user.id;
      if (url.pathname === '/api/v1/devices/approvals' && req.method === 'POST') {
        if (who.kind !== 'machine') throw new Refused('HUMAN_REQUIRED', 'request this approval with the linked board’s machine credential');
        await authorizeBoard(req, who.board);
        const body = exact(await readApiBody(req, { maxBytes: 40000 }), ['context', 'sealed']);
        const context = approvalContext(body.context);
        if (context.account !== account || context.publisher !== who.board || context.machine !== who.machine) throw new Refused('TOKEN_BOARD', 'publish approval only for this authenticated machine and board');
        apiJson(res, 200, { approval: devices.requestApproval(account, context, body.sealed) }); return true;
      }
      const approvalRoute = /^\/api\/v1\/devices\/approvals\/([A-Za-z0-9_-]{1,80})(?:\/(authorize|complete|execute))?$/.exec(url.pathname);
      if (approvalRoute) {
        if (!['session', 'machine'].includes(who.kind)) throw new Refused('HUMAN_REQUIRED', 'use the phone session or the publishing machine for this approval');
        if (who.kind === 'machine') await authorizeBoard(req, who.board);
        const [, id, action] = approvalRoute;
        const request = devices.approval(account, id, who.kind === 'machine' ? { board: who.board, machine: who.machine } : undefined);
        if (!action && req.method === 'GET') { apiJson(res, 200, { approval: request }); return true; }
        if (req.method !== 'POST') throw new Refused('NO_ENDPOINT', 'use the documented phone approval action');
        if (action === 'execute') {
          if (who.kind !== 'machine') throw new Refused('HUMAN_REQUIRED', 'execute the native command with its approved machine grant');
          const body = exact(await readApiBody(req), ['grant']);
          const context = request.context;
          const principal = await consumeActionGrant(req, body.grant, context);
          let result;
          if (context.action === 'revoke-device') { devices.revoke(account, context.target); result = { deviceId: context.target, revoked: true }; }
          else if (context.action === 'revoke-token') result = await revokeToken(principal, context.target, context.board);
          else throw new Refused('PHONE_APPROVAL_CONTEXT', 'use the exact approved native revocation');
          apiJson(res, 200, { result }); return true;
        }
        if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'only the signed-in paired phone can approve or complete this request');
        if (request.state !== 'waiting') throw new Refused('PHONE_APPROVAL_USED', 'this approval was used or expired; use its existing reply');
        if (action === 'authorize') {
          exact(await readApiBody(req), []);
          const context = request.context;
          let result;
          if (context.action === 'link') {
            await linkBoard(req, context.board, context.target);
            result = { credential: await issueMachine(req, { board: context.board, machine: context.machine }) };
          } else if (context.action === 'delete-board') {
            await deleteBoard(req, context.board);
            result = { deleted: context.board };
          } else result = await issueActionGrant(req, context);
          apiJson(res, 200, { result }); return true;
        }
        if (action === 'complete') {
          const body = exact(await readApiBody(req, { maxBytes: 40000 }), ['response']);
          apiJson(res, 200, devices.completeApproval(account, id, body.response)); return true;
        }
        throw new Refused('NO_ENDPOINT', 'use the documented phone approval action');
      }
      if (who.kind === 'session' && req.method === 'GET') {
        const inbox = /^\/api\/v1\/devices\/(device-[0-9a-f]{32})\/approvals$/.exec(url.pathname);
        if (inbox) { apiJson(res, 200, { approvals: devices.approvals(account, inbox[1]) }); return true; }
      }
      // A machine may wrap only its own board to an already enrolled device, never enroll or revoke.
      if (who.kind === 'machine') {
        const wrap = /^\/api\/v1\/devices\/(device-[0-9a-f]{32})\/boards\/([0-9a-f]{32})$/.exec(url.pathname);
        if (!wrap || req.method !== 'PUT' || wrap[2] !== who.board) throw new Refused('HUMAN_REQUIRED', 'approve device management from the paired phone');
        await authorizeBoard(req, who.board);
        const body = exact(await readApiBody(req, { maxBytes: 8192 }), ['engine', 'wrapped']);
        if (!Number.isSafeInteger(body.engine) || body.engine < 6 || typeof body.wrapped !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/u.test(body.wrapped) || Buffer.from(body.wrapped, 'base64url').toString('base64url') !== body.wrapped) throw new Refused('DEVICE_WRAP', 'send a versioned opaque wrap for this board');
        devices.put(account, wrap[1], who.board, body.engine, body.wrapped);
        apiJson(res, 200, { recorded: true }); return true;
      }
      if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'Sign in as a person to pair or revoke a device.');
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
