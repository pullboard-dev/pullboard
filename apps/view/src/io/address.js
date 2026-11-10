/** Choose an assigned local-network address only for an explicit LAN view [H19]. */
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Refused } from "../../../../packages/kernel/index.js";

/** Recognize private and link-local IPv4 addresses; the initial LAN transport does not bind a public interface. */
function localAddress(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168 || first === 169 && second === 254;
}

/** Bind one actual interface, never 0.0.0.0, and prefer physical Ethernet or Wi-Fi to virtual adapters. */
export function viewLanAddress(interfaces = networkInterfaces()) {
  const addresses = Object.entries(interfaces).flatMap(([name, rows]) => (rows ?? [])
    .filter(row => !row.internal && row.family === 'IPv4' && localAddress(row.address))
    .map(row => ({ name, address: row.address })));
  addresses.sort((first, second) => Number(!/^(en|eth|wl)/u.test(first.name)) - Number(!/^(en|eth|wl)/u.test(second.name))
    || first.name.localeCompare(second.name) || first.address.localeCompare(second.address));
  if (!addresses.length) throw new Refused('LAN_UNAVAILABLE', 'this machine has no assigned private local IPv4 address for a LAN view',
    'connect to a local IPv4 network, then run pullboard view --lan; ordinary pullboard view remains available on this machine');
  return addresses[0].address;
}
