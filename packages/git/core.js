/** Git light door: the process, identity and trunk reads the runner worker uses [C7]. */
export * from "./src/shell/git-adapter.js";
export { cleanGitEnvironment, gitPath, mainCheckout, repoInfo, tryGit } from "./src/shell/git.js";
export { trunkRef } from "./src/shell/git-trunk-ref.js";
