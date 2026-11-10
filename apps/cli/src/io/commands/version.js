/** The pullboard version command, in its own module so an item adding another command never edits these lines. */
// The release number lives in package.json; reading it here keeps --version to its own module [C7].
import packageData from '../../../../../package.json' with { type: 'json' };

/** Run `pullboard version` (or any command with --version) and return its exit code. */
export function run(io) {
  io.result?.({ release: packageData.version });
  io.say(packageData.version);
  return 0;
}
