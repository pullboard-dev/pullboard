/** Git light door: the process, identity and trunk reads the runner worker uses [C7]. */
export * from "./src/io/adapter.js";
export { git, gitChildEnv, cleanGitEnvironment, gitConfig, gitPath, headCommit, headTree, isClean, mainCheckout, pinnedSpecText, pinnedWorkingText, repoInfo, treeUntouched, tryGit, untracked, withGitCommandMemo, withGitFacts } from "./src/io/main.js";
export { trunkRef } from "./src/io/trunk/ref.js";
export { codeIsFromMain, differFromHead, gitReadSignature, invalidateGitFacts, resolveCommit, sameCommonDir, setResumeSourceFacts } from "./src/io/main.js";
