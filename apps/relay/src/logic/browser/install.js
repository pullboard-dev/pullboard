/** Optional browser installation and durable pairing storage [H5,H15]. */

/** Register only our same-origin worker; failure leaves the online page usable. */
export async function registerApp(browser = globalThis.navigator) {
  if (!browser?.serviceWorker?.register) return null;
  try { return await browser.serviceWorker.register('/service-worker.js', { scope: '/' }); }
  catch { return null; } // Installation is optional; the normal online transport remains available.
}

/** Ask to retain this origin's pairing after it is saved, without claiming a browser guarantee. */
export async function requestPairingPersistence(browser = globalThis.navigator) {
  if (!browser?.storage?.persist) return false;
  try { return await browser.storage.persist() === true; }
  catch { return false; } // Refused or unavailable storage gets the same safe, actionable notice.
}

/** Whether the Home Screen step is still worth showing: never in an installed page, always on iOS Safari, else only when persist was refused [H5,H15,#10971]. */
export function homeScreenStepNeeded({ kept, ios, standalone }) {
  if (standalone) return false;
  if (ios) return true; // iOS keeps site storage only for a Home Screen app, whatever persist said.
  return kept !== true;
}

/** Read whether this browser is iOS and whether the page already runs as an installed app, from the browser's own answers [H5,H15,#10971]. */
export function detectInstallContext(nav = globalThis.navigator, matchMedia = globalThis.matchMedia) {
  const agent = String(nav?.userAgent ?? '');
  const ipadOs = /Macintosh/u.test(agent) && Number(nav?.maxTouchPoints) > 1; // iPadOS reports a Mac with touch points.
  const ios = /iPhone|iPad|iPod/u.test(agent) || ipadOs;
  let displayStandalone = false;
  try { displayStandalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)')?.matches === true; }
  catch { displayStandalone = false; }
  return { ios, standalone: nav?.standalone === true || displayStandalone };
}
