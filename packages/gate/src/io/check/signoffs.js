#!/usr/bin/env node
/** Check every incoming PR or main-push commit against the event's trusted base policy [C1,C7]. */
// The light commits door alone, not the commits barrel: the barrel's hooks load node:sqlite, whose
// ExperimentalWarning would break the one-line refusal CI prints [C1,C7].
import { contributionSignoffProblem } from '../../../../commits/light.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { environmentAdapter } from '../../../../env/index.js';

const fs = fileSystemAdapter();
const environment = environmentAdapter();

/** Use structured event data rather than interpolating contributor-controlled values into a shell. */
function main() {
  const event = JSON.parse(fs.readFile(environment.get('GITHUB_EVENT_PATH'), 'utf8'));
  let range;
  if (environment.get('GITHUB_EVENT_NAME') === 'pull_request') {
    range = { base: event.pull_request?.base?.sha, head: event.pull_request?.head?.sha };
  } else if (environment.get('GITHUB_EVENT_NAME') === 'push') {
    range = { base: /^0+$/u.test(event.before ?? '') ? null : event.before, head: event.after };
  } else throw new Error('Run the sign-off check for a pull_request or push event with its complete event file.');
  const result = contributionSignoffProblem(process.cwd(), range);
  if (result.problem) {
    process.stderr.write(result.problem + '\n');
    process.exitCode = 1;
  } else if (result.policyInactive) {
    process.stdout.write('sign-off policy not active at base ' + (range.base ?? '(none)') + '\n');
  } else process.stdout.write('Contributor sign-offs checked: ' + result.checked + ' non-merge commits.\n');
}

try { main(); }
catch (error) {
  process.stderr.write('pullboard sign-off: ' + String(error.message).replace(/[\r\n]+/gu, ' ') + '\n');
  process.exitCode = 1;
}
