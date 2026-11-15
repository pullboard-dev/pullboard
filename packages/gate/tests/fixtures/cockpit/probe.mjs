// pullboard: browser
/** @pullboard-module-loads apps/cli/tests/fixtures/chrome/args.js apps/cli/tests/fixtures/chrome.js apps/cli/tests/fixtures/cockpit/harness.js */
/**
 * A stand-in test file for packages/gate/tests/stable.test.js: it opens Chrome through one launcher, reports ready, and idles [C7].
 * Why: the launchers live in the CLI's fixtures, so the test hands in their folder as PROBE_KIT and this package file imports no app.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Load one CLI fixture module from the folder the test named. */
const kit = file => import(pathToFileURL(join(process.env.PROBE_KIT, file)).href);
const { chromeLaunchArgs } = await kit('chrome/args.js');
const { findChromeExecutable, launchChromeProcess, startChrome: openChrome } = await kit('chrome.js');
const { chromeExecutable, openSnapshotChrome } = await kit('cockpit/harness.js');

const profile = process.env.PROBE_PROFILE;
if (process.env.PROBE_LAUNCHER === 'startChrome') await openChrome({ profileDirectory: profile });
else if (process.env.PROBE_LAUNCHER === 'launchChromeProcess') {
  launchChromeProcess({ executable: findChromeExecutable(), args: chromeLaunchArgs(profile) });
} else await openSnapshotChrome(chromeExecutable(), 'about:blank', profile);
writeFileSync(process.env.PROBE_READY, String(process.pid));
setInterval(() => {}, 1000);
