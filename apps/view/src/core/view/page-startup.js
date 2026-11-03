/**
 * The hosted page's startup helpers. src/cockpit.js embeds each one's source text in the page, so each may use only
 * its arguments and browser globals.
 */

/** Read, keep or forget a value for this tab only; a browser that refuses keeps nothing, and the page goes on. */
export function tabValue(name, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(name);
    if (value === null) sessionStorage.removeItem(name);
    else sessionStorage.setItem(name, value);
  } catch { return null; }
  return value;
}

/**
 * What the page's startup needs to know about this device, and its two safeguards (#900). A phone never runs
 * Pullboard, so it never looks for this computer's view, and its relay shell is its only screen, so a startup failure
 * is said there. No startup wait goes without a deadline.
 *
 * @param {HTMLElement} root - The document's root element, which the relay's page marks as a phone before first paint.
 */
export function pageStartup(root) {
  const phone = root.dataset.relayDevice === 'phone';
  return {
    phone,
    /** Put text in the phone shell's status line and keep the shell showing; false on a computer or without a shell. */
    say(text) {
      const status = phone ? root.querySelector('#relay-screen .relay-live span') : null;
      if (!status) return false;
      root.dataset.relayScreen ||= 'share';
      status.textContent = text;
      return true;
    },
    /** Whether this browser keeps relay board keys, so it was paired and signed in here before (#902). */
    pairedBefore() {
      try { return Object.keys(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') || '{}')).length > 0; } catch { return false; }
    },
    /** Await load(), failing with message after ms; the timer is cleared either way, so it never outlives the load. */
    within(load, ms, message) {
      let timer;
      const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
      return Promise.race([load(), late]).finally(() => clearTimeout(timer));
    },
  };
}
