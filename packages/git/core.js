/** Git light door: the Git process, identity and trunk reads the runner worker uses, without loading memory, receipts or worktree code [C7,CD60]. */
export { gitSpawn, gitSpawnSync, gitExecFileSync } from "./src/shell/git-adapter.js";
export { cleanGitEnvironment, gitPath, mainCheckout, repoInfo, tryGit } from "./src/shell/git.js";
export { trunkRef } from "./src/shell/git-trunk-ref.js";
