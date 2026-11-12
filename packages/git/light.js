/** Git light door: the process, identity and trunk reads the runner worker uses [C7]. */
export * from "./src/io/adapter.js";
export { cleanGitEnvironment, gitPath, headCommit, headTree, isClean, mainCheckout, repoInfo, tryGit, untracked } from "./src/io/main.js";
export { trunkRef } from "./src/io/trunk/ref.js";
