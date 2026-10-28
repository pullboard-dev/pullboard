/**
 * What a landing reads about its exceptions [B3,R3]: which kind a person's waiver is, whether it
 * covers one failure, and the flaky tests the coordinator filed. Each needs only its arguments, so
 * it lives beside the board's store, and src/board.js re-exports it for every existing caller.
 */

/**
 * Name what a waiver argument is: a test file path, or a test's name. A path is a directory and a
 * file with an extension (spaces and any language allowed), or one spaceless file name with an
 * extension; anything else is a name. Waiver history retains the person's original argument;
 * classification is a derived read, so released ordered receipts stay unchanged.
 * Guessing wrong only narrows a waiver, since each kind matches one field of a failure.
 */
export function landingWaiverKind(test) {
  return /^[^\r\n]*\/[^/\r\n]*[^/\s.]\.[A-Za-z0-9]+$/u.test(test) || /^[^\s/]+\.[A-Za-z0-9]+$/u.test(test) ? 'file' : 'name';
}

/**
 * True when a waiver covers one failure: a file waiver only its file, a name waiver only its name.
 * Keeping the kinds apart stops a new test named like a waived file from riding that waiver [B3,R3].
 */
export function landingWaiverCovers(waiver, failure) {
  // A quarantine names the test by file and name together, so it never covers a same-named test elsewhere [C7,D1].
  if (waiver.quarantine) return waiver.quarantine.file === failure.file && waiver.quarantine.name === failure.name;
  return (waiver.kind ?? landingWaiverKind(waiver.test)) === 'file' ? waiver.test === failure.file : waiver.test === failure.name;
}

/** Read the latest observation of each named flaky test [B3,R3]. */
export function landingFlakes(board) {
  const flakes = new Map();
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing_flake' ORDER BY event_id").all()) {
    const { flake } = JSON.parse(row.event_detail);
    flakes.set(flake.test, flake);
  }
  return [...flakes.values()];
}
