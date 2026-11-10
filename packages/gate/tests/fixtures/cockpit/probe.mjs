// pullboard: browser
/** A stand-in test file for packages/gate/tests/stable.test.js: it opens Chrome through one launcher, reports ready, and idles [C7]. */
import { chromeLaunchArgs } from '../../../../../apps/cli/tests/fixtures/chrome/args.js';
import { writeFileSync } from 'node:fs';
import {
  findChromeExecutable,
  launchChromeProcess,
  startChrome as openChrome,
} from '../../../../../apps/cli/tests/fixtures/chrome.js';
import {
  chromeExecutable,
  openSnapshotChrome,
} from '../../../../../apps/cli/tests/fixtures/cockpit/harness.js';

const profile = process.env.PROBE_PROFILE;
if (process.env.PROBE_LAUNCHER === 'startChrome') await openChrome({ profileDirectory: profile });
else if (process.env.PROBE_LAUNCHER === 'launchChromeProcess') {
  launchChromeProcess({ executable: findChromeExecutable(), args: chromeLaunchArgs(profile) });
} else await openSnapshotChrome(chromeExecutable(), 'about:blank', profile);
writeFileSync(process.env.PROBE_READY, String(process.pid));
setInterval(() => {}, 1000);
