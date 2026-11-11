import {Issue} from '../classes/issue.js';

export function isPullRequest(issue: Readonly<Issue>): boolean {
  return !!issue.pull_request;
}
