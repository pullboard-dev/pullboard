/** Doctor's toolchain finding: a language the repo uses that no registered runner declares a toolchain for [C7]. */

/**
 * One problem per needed toolchain that no runner declares, each naming the runner step that adds it.
 * Why: nothing told the person a Go repo had no runner able to test it until a job sat unrouted. Runners that declare
 * no toolchains at all say nothing either way, so with none declaring, nothing is reported.
 *
 * @param {string[]} needed toolchains the repo's detected languages need
 * @param {{ host: string, toolchains?: Record<string, string> }[]} runners the machine's registered runners
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function toolchainProblems(needed, runners) {
  const declaring = runners.filter(runner => Object.keys(runner.toolchains ?? {}).length > 0);
  if (!declaring.length) return [];
  const declared = new Set(declaring.flatMap(runner => Object.keys(runner.toolchains)));
  return needed.filter(name => !declared.has(name)).map(name => ({
    code: 'RUNNER_TOOLCHAIN_MISSING',
    message: `toolchain ${name} is missing on every runner, so a ${name} job would sit unrouted`,
    next: `run pullboard runner add <ssh-host> --toolchain ${name}=<version> on a machine that has ${name}`,
  }));
}
