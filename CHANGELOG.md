# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bots.** The host can seat up to seven bots, each with a distinct persona.
  They run on Kimi (Moonshot) or DeepSeek when a key is configured and fall back
  to a built-in rule policy — Chen formula preflop, hand category and pot odds
  postflop — on timeout, rate limit, unparseable output, or no key at all. A
  provider that fails three times in a row is benched for 60 seconds. New
  `addBot` client message and `bot` field on seat snapshots; contract is in
  `SPEC.md` §8.4.
- Bot backend can be configured from the browser instead of the environment —
  the host pastes a key under Settings. It is held in process memory only, never
  written to the log, and never broadcast: the masked form is sent to the host
  alone, other players see only whether an LLM is attached.
- **Show cards.** When you take the pot without a showdown, a button offers to
  reveal your hole cards to the table. One-shot per hand, cleared on the next
  deal; new `showCards` message and `you.canShowCards` in the snapshot.
- **Monte Carlo equity** in the decision prompt, sized by the number of opponents
  still in the hand, with split pots pro-rated and the modelling assumption stated
  alongside the number. The work is chunked — 8 ms of computation, then the event
  loop is yielded — so 20,000 trials (±0.5%) cost a 15 ms peak stall instead of
  90 ms, and precision no longer trades against smoothness. Adds `bot/equity.js` and
  `bot/fastscore.js` — a score-only 7-card path, 11–40× faster than the general
  evaluator, using the identical formula and cross-checked bit-for-bit against it.
- Randomly generated bot personas: five orthogonal traits, 243 combinations. The
  traits are structured, so the rule fallback shifts its thresholds by them rather
  than the personality being cosmetic.
- Table defaults can be pinned via environment variables (`POKER_BLINDS`,
  `POKER_STARTING_STACK`, `POKER_ACTION_TIMEOUT`, …) so a redeploy no longer resets
  them to the code defaults. Validation ranges match the settings panel exactly —
  an invalid value is logged with its legal range and falls back instead of being
  silently accepted. New `server/config.js`.
- Bots are swept off the table once the last human gives up their seat, and the
  table (hand, log, chat) is wiped with them. Bots never stand up on their own
  and never inherit the host role, so a table left to them could not be cleared
  by anyone. A disconnected player still holds their seat — the sweep waits for
  the 15-minute grace period, matching the existing rule that hands do not deal
  while nobody is watching. `SPEC.md` §8.4.5.
- `.env.example` documenting every environment variable, and pass-through of the
  bot settings in `docker-compose.yml`.
- English `README.md`, with the original Chinese documentation moved to
  `README.zh-CN.md`.
- Open-source project files: `LICENSE` (GPL-3.0), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, this changelog, issue and pull request
  templates, and `.editorconfig`.
- GitHub Actions CI: tests on Node 22 and 24, `node --check` over all sources,
  `shellcheck` on the deploy script, and a Docker build that boots the image and
  verifies `/healthz`.

- **Chips you can see.** Bets and the pot are drawn as real chip stacks, split
  into casino denominations (white 1, red 5, green 25, blue 100, black 500, gold
  1000). At the end of each street the chips on the felt fly into the pot, and
  when a hand is settled the pot is pushed to the winner once the result screen
  steps aside.

### Fixed

- `POKER_DOMAIN` had no effect on the generated Caddy site block. The domain was
  hard-coded in `deploy/caddy-site.txt`, so deploying to any other domain
  silently produced a Caddyfile serving the wrong host. The snippet now uses a
  `__DOMAIN__` placeholder that `deploy.sh` substitutes at write time.

### Changed

- The table is a racetrack instead of an ellipse: straight long sides, semicircular
  ends, the shape a real hold'em table has. Seats are placed on the outline from
  the current geometry — three along each long side, one at each end — so they stay
  glued to the rail when the table turns upright on a phone in portrait.
- The two idle buttons say what they do: 「坐出一手」 is now 「暂时离开」 and
  「离座」 is now 「退出」.
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
