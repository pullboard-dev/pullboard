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
