import { createHmac } from 'node:crypto';

/**
 * The view's session cookie, derived from its secret with a fixed label for each part, so a view restarted
 * with the same secret accepts the cookie the first one set, and a view with another secret refuses it.
 *
 * @param {string} secret
 * @returns {{ name: string, value: string }}
 */
export function viewSessionCookie(secret) {
  const derive = (label, encoding) => createHmac('sha256', secret).update(label).digest(encoding);
  return {
    name: `pullboard_view_${derive('pullboard-view-cookie-name', 'hex').slice(0, 18)}`,
    value: derive('pullboard-view-session', 'base64url'),
  };
}
