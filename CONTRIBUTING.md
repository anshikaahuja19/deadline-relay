# Contributing to deadline-relay

Thanks for your interest in improving deadline-relay!

## Getting started

```bash
git clone https://github.com/anshikaahuja19/deadline-relay.git
cd deadline-relay
npm test               # Node's built-in test runner; no install needed
npm run test:coverage  # with a coverage report
npm run example        # three-service demo
```

The project has no runtime or development dependencies. Node.js 18+ is all you need.

## Project layout

```
src/
  index.js        public exports
  deadline.js     the Deadline class, parseBudget(), constants
  middleware.js   deadline() middleware and the default 504 responder
  errors.js       DeadlineExceededError, CancelledError
test/
  deadline.test.js     unit tests (uses an injectable clock for exact timing)
  middleware.test.js   integration tests against real node:http servers
examples/              runnable usage examples
```

## Making a change

1. Fork the repository and create a branch: `git checkout -b feat/my-change`.
2. Make your change and add tests. Line coverage should stay at 100%.
3. Update `README.md` if behaviour or the public API changes.
4. Add a line under **Unreleased** in `CHANGELOG.md`.
5. Run `npm test` and open a pull request explaining what changed and why.

### Conventions

- Plain CommonJS JavaScript, `'use strict'`, two-space indentation (see `.editorconfig`).
- JSDoc comments on public functions and methods.
- Timing tests: prefer the `clock` option for exact assertions; when real timers
  are needed keep them short (tens of ms) and assert with generous slack so CI
  stays reliable.
- Never leave timers running: every `Deadline` created in a test is disposed,
  expired, or cancelled.
- No runtime dependencies without discussion in an issue first.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`.

## Reporting bugs

Open an issue with your Node.js version, framework (Express, Fastify, plain
http…), a minimal reproduction, and what you expected to happen.

## Releasing (maintainers)

The project follows [Semantic Versioning](https://semver.org/):

| Change | Command |
| --- | --- |
| Bug fix, no API change | `npm version patch` |
| New backwards-compatible feature | `npm version minor` |
| Breaking change | `npm version major` |

```bash
# 1. Move the "Unreleased" notes in CHANGELOG.md under the new version, commit.
npm version minor        # bumps package.json, commits, and creates a git tag
git push --follow-tags
npm publish              # prepublishOnly runs the tests first
```
