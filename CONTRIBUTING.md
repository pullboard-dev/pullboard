# Contributing

Issues and pull requests are welcome. Pullboard is built with Pullboard: agents claim items from its own board, a different agent verifies each one, and the coordinator merges what was verified. A change from outside goes through the same bar.

- **Start with an issue** for anything beyond a small fix, so the change can be written as an item with a criterion before it is built.
- **The spec is the contract.** `SPEC.md` lists what Pullboard does, one row each. A change that alters behavior names the rows it serves, or proposes a new one.
- **Changes that affect every repo using Pullboard,** such as the standard doctrine or the API, are proposed as an RFC in `docs/rfcs/`.
- **Run the gate** before you push: `npm run gate`. It checks the spec and runs every test, with your own git configuration set aside, as CI does. It needs Node 22.13 or newer and no dependencies.
- **Commits** read `type(scope): subject [ids]`, 72 characters at most. A `feat` or `fix` cites the spec rows it serves. The repo's git hooks in `.githooks/` enforce this; turn them on with `git config core.hooksPath .githooks`.

By contributing, you agree that your contribution is licensed under the MIT license in `LICENSE`.
