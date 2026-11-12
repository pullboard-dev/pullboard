/** Validate relay origins independently of link state or transport [H5]. */
import { Refused } from '../../../../kernel/light.js';

/** Require a trusted origin; HTTP exists only for loopback development and test relays. */
export function relayOrigin(address) {
  let url;
  try { url = new URL(address); } catch { throw new Refused('RELAY_URL', 'use an HTTPS relay address, such as https://app.pullboard.dev'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Refused('RELAY_URL', 'use an HTTPS origin without credentials, a path, query or fragment; loopback HTTP is allowed for a local relay');
  }
  return url.origin;
}
