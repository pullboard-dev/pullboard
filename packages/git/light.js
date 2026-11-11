/** Git light door: the process, identity and trunk reads the runner worker uses [C7]. */
export * from "./src/io/adapter.js";
export { cleanGitEnvironment, gitPath, mainCheckout, repoInfo, tryGit } from "./src/io/main.js";
export { trunkRef } from "./src/io/trunk/ref.js";
