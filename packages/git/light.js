/** Git light door: the process, identity and trunk reads the runner worker uses [C7]. */
export * from "./src/io/adapter.js";
export { cleanGitEnvironment, gitConfig, gitPath, headCommit, headTree, isClean, mainCheckout, pinnedSpecText, pinnedWorkingText, repoInfo, treeUntouched, tryGit, untracked, withGitCommandMemo, withGitFacts } from "./src/io/main.js";
export { trunkRef } from "./src/io/trunk/ref.js";
export { createGitMemo } from "./src/io/memo.js";
