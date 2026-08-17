# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- English `README.md`, with the original Chinese documentation moved to
  `README.zh-CN.md`.
- Open-source project files: `LICENSE` (GPL-3.0), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, this changelog, issue and pull request
  templates, and `.editorconfig`.
- GitHub Actions CI: tests on Node 22 and 24, `node --check` over all sources,
  `shellcheck` on the deploy script, and a Docker build that boots the image and
  verifies `/healthz`.

### Fixed

- `POKER_DOMAIN` had no effect on the generated Caddy site block. The domain was
  hard-coded in `deploy/caddy-site.txt`, so deploying to any other domain
  silently produced a Caddyfile serving the wrong host. The snippet now uses a
  `__DOMAIN__` placeholder that `deploy.sh` substitutes at write time.

### Changed

- `POKER_DOMAIN` is now required and has no default. It can be set once in
  `.env` on the server, which `deploy.sh` reads at startup; a real environment
  variable still takes precedence.
- The deploy script derives the Cloudflare record name and zone from
  `POKER_DOMAIN` instead of printing hard-coded values, and auto-detects the
  server's public IP rather than carrying it in the repository.

## [1.0.0] - 2026-08-15

First working version.

### Added

- Full no-limit Texas Hold'em for one table of eight seats: blinds and antes,
  button rotation, four betting streets, all-ins with layered side pots,
  automatic showdown evaluation, and pot distribution with odd-chip rules.
- No-signup seating — a nickname is the identity, avatars derive from it.
- Reconnection via a seat token in `localStorage`, returning a player to the
  same seat and stack. Disconnected seats are held for 15 minutes.
- Per-viewer redacted state snapshots so hole cards never reach clients that are
  not entitled to them.
- Host controls: blinds, ante, starting stack, action clock, auto-start, topping
  up stacks, kicking players, and resetting the table.
- Action timeouts that check when legal and fold when not, so an idle player
  cannot stall the table.
- Zero-build frontend with no external requests — cards are drawn in CSS.
  Portrait phone layout, keyboard shortcuts, and sound cues.
- Test suites for the evaluator (including a randomised cross-check against a
  brute-force implementation), the betting engine (side pots, min-raise rules,
  the big blind option, chip conservation, randomised fuzzing), and an
  end-to-end pass over the real WebSocket server.
- Container and deployment kit: Dockerfile, compose file, and an idempotent
  deploy script that attaches to an existing Caddy instance and rolls back
  automatically if validation or reload fails.

[Unreleased]: https://github.com/Jinzhengxu/poker-table/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Jinzhengxu/poker-table/releases/tag/v1.0.0
