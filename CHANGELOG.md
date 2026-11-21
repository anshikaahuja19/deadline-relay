# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-11-21

### Fixed

- Made the downstream-timeout tests reliable on slow CI machines.

### Documentation

- Explained that `deadline.fetch()` returns a downstream 504 as a normal
  response, and rejects only when your own deadline fires first.

## [1.0.0] - 2026-11-21

### Added

- `deadline()` middleware for Express, Connect and `node:http`. It reads the
  caller's budget from `x-request-timeout-ms`, attaches `req.deadline`, replies
  504 on expiry, and cancels the deadline when the client disconnects.
- `Deadline` class with `signal`, `remaining()`, `expired`, `fetch()`,
  `race()`, `child()`, `toHeaders()`, `throwIfExpired()`, `cancel()` and
  `dispose()`.
- `Deadline.fromHeaders()` to read a budget from Node or WHATWG headers.
- Options: `timeout`, `max`, `header`, `reserve`, `trustIncoming`, `onExpired`.
- `DeadlineExceededError` and `CancelledError`, each with a stable `code`.
- `parseBudget()`, `respondGatewayTimeout()`, `DEFAULT_HEADER` and `MAX_BUDGET`.

[Unreleased]: https://github.com/anshikaahuja19/deadline-relay/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/anshikaahuja19/deadline-relay/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/anshikaahuja19/deadline-relay/releases/tag/v1.0.0
