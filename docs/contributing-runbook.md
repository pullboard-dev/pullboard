# Procedure: handling an outside contribution (maintainers and the coordinator)

This is the internal runbook. Contributors read CONTRIBUTING.md; this file is for us.

## When an issue arrives
1. Reply when capacity allows: thank them, and say what happens next ("on our board as #N", "a question first", or "not planned, because...").
2. File it on the board, or map it onto an existing item or milestone. Link the board item in the reply.
3. If you need more from the reporter, label it `clarify`. A clarify issue closes after 14 quiet days and keeps its `clarify` label; a reply reopens it.

## When a pull request arrives
1. **Reply when capacity allows; there is no fixed response time.** Thank them.
2. **Read the diff before running anything.** Look for:
   - changes outside the stated purpose;
   - new dependencies (refuse them);
   - anything touching sensitive paths (relay, sealing, signing, person moves, hooks, code that runs commands);
   - network calls, file access outside the repo, obfuscation, big pasted blocks.
3. **File it as a board item.** The bar is the linked issue's behaviour. The check is the contributor's new test, which must fail on `main` and pass at their commit. Record the PR number, the author and the exact commit.
4. **Verify in the sandbox only:**
   - a container or throwaway VM with no credentials, no access to the home folder and no network;
   - the full gate on the minimum Node version (22.13) plus the current version;
   - the browser tests when the change touches the view or relay;
   - outside code never runs on a machine holding credentials.
5. **Sensitive paths need the owner's approval** on top of the verifier's accept.
6. **Confirm the [CLA](../CLA.md) before merge:** the contributor accepts it by posting "I have read CLA.md and I agree to it." as a comment on their pull request, the first time they contribute. **Then land through the merge train.** Never use GitHub's merge button. The contributor stays the commit author; if we changed their commit, they're credited with `Co-authored-by`.
7. **Close the loop.** The PR shows as merged, or we close it with a link to the landed commit. Thank them, and link the receipt.
8. **If it fails,** comment with the verifier's note in plain words ("fails on Node 22.13: ..."). When they update, the item is verified again at the new commit.
9. **Declining:** close with a clear, kind reason. Merging is always the project's call.

## Standing rules
- Outsiders never get commit rights, npm publishing rights or any token.
- GitHub and npm accounts use 2FA. Releases are published only by the owner's release process.
- `main` is protected: only the coordinator's landing updates it.
- CODEOWNERS requests the owner's review on sensitive paths.
- Inbound contributions are MIT, with a lightweight CLA agreed with one pull request comment (decided 22 Oct; the DCO dropped 8 Nov). Make no public promise about future licensing.

## Changelog acknowledgements

Acknowledgement is at the maintainer's discretion: trivial reports or many related issues may get none. It is a record, not a thank-you. When given, the changelog entry ends with its board item and a linked acknowledgement:

- Bug: `(#1325; reported in [GitHub #10](https://github.com/pullboard-dev/pullboard/issues/10) by @McHersheys)`
- Feature: `(#1321; requested in [GitHub #7](https://github.com/pullboard-dev/pullboard/issues/7) by @Herklos)`
- The person's own pull request: `(#1330; [PR #9](https://github.com/pullboard-dev/pullboard/pull/9) by @McHersheys)`

When an item with a handled reference ships, its changelog line carries the acknowledgement in the matching form above. The handle records the maintainer's choice to acknowledge that issue's or pull request's author; a reference without a handle gets no acknowledgement. Do not publish private, unhandled references.

The docs check validates every changelog line containing `GitHub #` or `PR #`, including the linked number and whether it names an issue or pull request. Syntax validation does not look up GitHub authors; confirm the handle against the referenced author when granting the acknowledgement.

## Automation to build (so this runs without anyone remembering it)
- **`pullboard intake <PR>`** (the first real use of the PR bridge):
  - fetches the PR's exact commit;
  - files the item with the PR and author recorded;
  - marks it outside, so verification runs only in the sandbox;
  - routes it to the owner when it touches a sensitive path;
  - posts the result back to the PR with the receipt (after the owner's OK while we start).

  Any project using Pullboard then gets the same safe contribution flow.
- **A sandboxed verify mode** for items marked outside.
- **PR template** with a linked-issue field.
- **A reply reminder:** keep unanswered issues and pull requests visible without promising a response time.
