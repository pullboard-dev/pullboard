/** jobs front door: the durable job store, one row per gate job or landing batch [C7]. */
export { createJob, writeStep, jobView } from "./src/shell/job-store.js";
export { shadowSubmitHandoff } from "./src/shell/job-shadow.js";
