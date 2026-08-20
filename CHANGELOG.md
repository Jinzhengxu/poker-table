# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Voice chat, with a separate channel per table.** A mic button in the top bar
  puts you on the table's voice channel. Hold'em and guandan get their own
  channel each: every `Room` owns a `VoiceChannel`, rosters are stored
  separately, and signalling is only ever relayed within that room's own client
  set — the two tables' client sets are disjoint by construction (different
  WebSocket paths), so audio cannot cross tables even in principle.

  Audio itself never touches the server. Browsers connect to each other over
  WebRTC in a full mesh (8 people max, `POKER_VOICE_MAX` to lower it) and the
  server only forwards a few kilobytes of SDP/ICE — it never parses SDP, only
  validates the envelope shape and size, and rebuilds the payload from an
  allow-list before forwarding. Signalling gets its own rate-limit bucket
  because ICE candidates arrive in bursts that would blow the 20/s table budget.

  In the UI: a green ring and a mic dot on the seat of whoever is speaking
  (detected locally from the audio streams, never reported to the server), a
  roster that docks into the sidebar on desktop and collapses to a row of
  avatars on phones, self-mute, and per-peer local mute. Leaving the table,
  being kicked, disconnecting, or reconnecting all drop you off the mic so peers
  tear down immediately instead of waiting for an ICE timeout.

  Requires HTTPS (or localhost) for microphone access. Direct browser-to-browser
  connections need a TURN relay to fall back on whenever both sides sit behind
  carrier-grade NAT, which `deploy/deploy.sh` now provisions automatically; a
  pair that cannot connect says so in the roster rather than failing silently.
  `POKER_VOICE=off` disables it entirely.

- `server/turn-check.js` (`npm run turn-check`, or
  `docker exec poker node server/turn-check.js` on a server): walks the voice
  path one link at a time — STUN reachability, whether TURN credentials
  authenticate, whether a relay channel can actually be allocated — and names
  the link that is broken. It reads configuration through `voiceConfigFromEnv`,
  the same path that produces what browsers receive, so passing here means the
  browser's configuration is genuinely usable. Implements the minimum of
  RFC 5389/5766 needed to do that honestly.

- **Guandan (掼蛋), a second table.** Served at `/guandan` on the same process,
  with its own WebSocket path (`/gd`), its own in-memory room, and its own seats
  and tokens — the hold'em table is untouched. Four players in two teams, 108
  cards, level-climbing to A. Implements the level card outranking A, the
  wild card (level card in hearts), all ten combination types with the full bomb
  ladder, relay when a finished player's team keeps the lead, tribute and return
  with the two-big-jokers refusal, and the A-level rules including the three-strike
  demotion. The exact house ruleset is written out in a Rules tab in the sidebar,
  because guandan varies by region and it is better to settle that before the deal
  than during it.
- Guandan combination logic lives in one file, `public/gd-combos.js`, imported by
  both the browser and the server; `public/gd-hints.js` does the same for candidate
  enumeration and is shared by the bots and the Hint button. Whether the Play button
  lights up and whether the server accepts the play are therefore the same
  computation. The server still revalidates independently — the client-side check
  buys responsiveness, not authority. A fuzz test asserts every combination the
  enumerator declares can be reproduced by the interpreter, which is the invariant
  holding the two halves together.
- Rule-based guandan bots so a short table can still play. The host fills empty
  seats from the sidebar; no API key is involved. The same policy drives the
  auto-play that covers a human's turn when their clock runs out, so a deal can
  never stall on one idle player.
- `GUANDAN_ACTION_TIMEOUT`, `GUANDAN_NEXT_DEAL_DELAY` and `GUANDAN_AUTO_NEXT_DEAL`
  set the guandan table's starting configuration, matching how the `POKER_*`
  variables work for hold'em.
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

- **Voice chat could not connect between people on different networks.** Two
  causes, both fixed. First, `docker-compose.yml` never passed any of the
  `POKER_VOICE*` / `POKER_STUN_URLS` / `POKER_TURN_*` variables into the
  container, so a TURN relay could not be configured on a deployed instance at
  all no matter what `.env` said. Second, nothing shipped a TURN server, and
  STUN alone cannot traverse two carrier-grade NATs — the common case for
  residential broadband. The failure was deceptive rather than obvious: joining
  succeeded, the roster listed everyone, and no audio ever arrived.

  `deploy/deploy.sh` now provisions the whole relay path: it generates a shared
  secret into `.env` (once — a fresh secret on every deploy would cut off
  anyone mid-call), starts a hardened coturn container behind a `turn` compose
  profile, opens the ports on ufw/firewalld, and verifies the result by actually
  allocating a relay channel rather than just checking that the process is up.
  coturn refuses to start without a secret, denies relaying to every private
  address range so it cannot be used to reach other services on the box, and
  caps per-session bandwidth and allocation quotas.

- TURN credentials are now signed per join (HMAC-SHA1 over an expiring username,
  the scheme coturn's `use-auth-secret` expects) instead of being a fixed
  username and password. The ICE configuration is handed to every visitor, so a
  static credential would be a publicly posted relay account; the shared secret
  now never leaves the server. `POKER_TURN_USERNAME` / `POKER_TURN_CREDENTIAL`
  still work for third-party TURN services.

- `stun.qq.com`, the first entry in the default STUN list, no longer answers
  binding requests (verified against both addresses it resolves to). Every ICE
  gathering pass was starting with a guaranteed timeout. Replaced with
  `stun.chat.bilibili.com`; the remaining defaults were re-verified.

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
