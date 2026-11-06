# Contributing

Thanks for helping. Pullboard is MIT-licensed.

## The short version

- **Issues are always welcome:** bugs, ideas and questions.
- **Pull requests are welcome too.** Every one goes through the same checks as the work Pullboard's own agents do, and nothing skips them.
- **Two quick steps for your first pull request:** agree to our Contributor License Agreement (one click, once) and sign off each commit (one flag). Both are explained below.

## Issues and pull requests

These are aims, not promises.

**Issues**
- We aim to have a first reply within 7 days.
- Labelled `bug`, `feature`, `question` or `docs`.
- `clarify`: closes after 14 days without a reply. Reply to reopen.
- Confirmed issues move to our board and close; the changelog may acknowledge them.
- Ideas and feedback in issues are welcome; Pullboard may use them freely, with no obligation. Code goes through a pull request.

**Pull requests**
- The CLA (once) and a sign-off on every commit.
- Each one becomes a board item and is verified like any other work.
- The relay, sealing, signing, approvals and Git hooks need the maintainer's approval.
- `SPEC.md` changes are proposals; the maintainer approves rows.
- Smaller is faster; large changes may be split.

## Licensing, the CLA and sign-off

**The Contributor License Agreement (CLA).** The first time you open a pull request, agree to Pullboard's CLA by posting this sentence as a comment on your pull request: "I have read CLA.md and I agree to it." You only do this once. In short:

- **You keep ownership** of your contribution.
- You give the Pullboard project a broad, permanent license to use, change and distribute it, including under other licenses in the future, plus a license to any patents of yours that your contribution needs.
- You confirm it's your own work, or that you have permission to contribute it.

Read the full text before agreeing: [CLA.md](CLA.md). It follows the Apache Individual Contributor License Agreement v2.2 terms, with Pullboard as recipient; the nonprofit-bylaws sentence and form fields are omitted, and acceptance is by posting that sentence as a comment on your pull request.

**The sign-off.** Each commit also carries a sign-off line confirming you have the right to submit it, as described in the [Developer Certificate of Origin 1.1](https://developercertificate.org/). `git commit -s` adds it for you:

```
Signed-off-by: Your Name <you@example.com>
```

A pull request can't be merged until the CLA is agreed and every commit is signed off.

Pullboard itself stays available to everyone under the MIT License. The CLA covers only what you contribute, and puts no conditions on people who use Pullboard.

### How to sign off, step by step

The sign-off is one line at the bottom of each commit message. Git writes it for you, using the name and email from your git settings.

**A new commit:** add `-s` when you commit.

```bash
git commit -s -m "fix(relay): finish pending reads before yielding"
```

The commit message now ends with:

```
Signed-off-by: Your Name <you@example.com>
```

**A commit you already made but haven't pushed:** add the line to your latest commit.

```bash
git commit --amend -s --no-edit
```

**A pull request you already opened.** Run these in your copy of the repository, on the branch the pull request comes from.

1. Add the sign-off to every commit on your branch (replace `main` if your branch started from something else):

   ```bash
   git rebase --signoff main
   ```

   With only one commit, `git commit --amend -s --no-edit` does the same.

2. Push the updated commits to your pull request:

   ```bash
   git push --force-with-lease
   ```

   This replaces the commits on your own branch only; nothing else is affected. Your pull request updates by itself within a few seconds.

3. Check it: open the pull request's **Commits** tab, click a commit, and confirm its message ends with your `Signed-off-by:` line.

**Editing on github.com instead of on your computer:** type the line yourself at the bottom of the commit message box, exactly like this, with your name and the email on your GitHub account:

```
Signed-off-by: Your Name <you@example.com>
```

**Sign off every commit automatically:** this creates a shortcut, `git cs`, for "commit with sign-off".

```bash
git config --global alias.cs "commit -s"
```

Then use `git cs -m "..."` instead of `git commit -m "..."`.

## What makes a good contribution

- **Start with an issue** for anything beyond a small fix, so we can agree on the behaviour first. Pullboard's requirements live in `SPEC.md`, and the project owner approves changes to them.
- **Bug fixes:** link the issue, and include a test that fails without your fix and passes with it.
- **Code:** plain JavaScript, ES modules, Node 22.13 or newer, and no new dependencies. Match the surrounding style. Run `npm run gate` before you open the pull request.
- **AI-assisted work is fine.** You're responsible for it, and it meets the same bar as everything else.

## What happens after you open a pull request

1. **We aim to reply within 7 days.**
2. **It becomes an item on Pullboard's own board.** The bar is the behaviour your issue describes.
3. **A second reviewer checks your exact commit.** That's one of our verifier agents, plus the project owner for sensitive areas. It runs the full test suite on the minimum Node version and confirms your test fails without your change.
4. **If it passes,** it lands on `main` through our normal landing process, with you credited as the author. If we had to adjust it, you're credited as co-author with `Co-authored-by`. The pull request shows as merged, or we close it with a link to where it landed.
5. **If it doesn't pass,** we comment with what failed, and you can update the pull request.

We may edit, combine or reimplement a contribution, and we may decline one with a reason. Merging is always the project's call.

## Sensitive areas

Changes to these also need the project owner's approval:
- the relay and board sealing;
- signing and keys;
- person-only moves (approvals, sign-offs);
- git hooks and the verification rules.

## Security issues

Don't open a public issue or pull request for a vulnerability. Report it privately through this repository's Security tab (see `SECURITY.md`).

## Conduct

Everyone here follows our [Code of Conduct](CODE_OF_CONDUCT.md).
