# Poker Table

[![CI](https://github.com/Jinzhengxu/poker-table/actions/workflows/ci.yml/badge.svg)](https://github.com/Jinzhengxu/poker-table/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

A self-hosted, no-signup Texas Hold'em table for playing with friends.
Open the page, click an empty seat, type a nickname — you're in.

**[中文文档 →](README.zh-CN.md)**

Full no-limit rules: blinds, button rotation, four betting streets, all-ins with
correctly layered side pots, automatic showdown evaluation and pot distribution.

## Why this exists

Most online poker either wants your money, your phone number, or both. This is a
single table you run yourself for a private game. No accounts, no database, no
tracking, no chips with real value — just a scoreboard your friends can reach
from a URL.

## Features

- **No signup.** A nickname is your identity. Avatars are derived from it.
- **One table, eight seats.** All state lives in memory. No database to run.
- **Reconnect-safe.** A seat token in `localStorage` puts you back in the same
  seat with the same stack after a refresh or a dropped connection.
- **Phone-friendly.** Portrait layout, the table scales proportionally, and
  action buttons are sized for thumbs.
- **Zero external dependencies in the browser.** No CDN, no webfonts, no images —
  the cards are drawn entirely in CSS. The server depends only on `ws`.
- **Small.** The container idles at roughly 18 MB of RAM.

## Quick start

```bash
git clone https://github.com/Jinzhengxu/poker-table.git
cd poker-table
npm install
npm start                 # http://localhost:8080
```

To try it solo, open two different browsers (or one normal window plus one
private window). Two tabs in the same browser are deliberately treated as the
same person, so one player cannot occupy two seats.

With Docker:

```bash
docker build -t poker-table:local .
docker run --rm -p 8080:8080 poker-table:local
```

## How to play

1. The first player to sit down is the **host**. The host can change blinds, top
   up stacks, kick players, and reset the table from the Settings tab.
2. A hand starts automatically once two or more seated players have chips. After
   each hand there is a short delay before the next one is dealt.
3. On your turn the action bar appears: **Fold / Check / Call N / Bet·Raise**.
   Raising offers a slider plus ½ pot, ⅔ pot, pot, and all-in shortcuts.
   Keyboard: `F` fold, `C` check or call, `R` raise, `Enter` confirm.
4. If you time out, the server checks for you when checking is legal and folds
   when it is not, so one idle player never stalls the table.

Defaults: blinds 5/10, ante 0, starting stack 1000, 45 s action clock, auto-start
enabled. All of them are configurable by the host between hands.

## Configuration

The server reads two environment variables:

| Variable | Default   | Meaning                    |
| -------- | --------- | -------------------------- |
| `PORT`   | `8080`    | HTTP + WebSocket port      |
| `HOST`   | `0.0.0.0` | Bind address               |

Everything about the game itself (blinds, ante, starting stack, action clock,
auto-start) is changed at runtime by the host, not through configuration files.

## Deployment

`deploy/deploy.sh` deploys the container behind an existing Caddy instance —
useful when the box already serves other sites on ports 80/443. It attaches the
container to Caddy's Docker network instead of claiming host ports, so it does
not disturb whatever is already running.

```bash
# once, on the server
echo 'POKER_DOMAIN=poker.example.com' >> .env
bash deploy/deploy.sh
```

The script detects the Caddy container and its network, builds and starts the
app, waits for the health check, backs up the Caddyfile, idempotently replaces
the site block between its markers, validates and reloads Caddy, then verifies
the whole chain end to end. **If validation or reload fails it restores the
backup automatically**, so a broken config cannot take down neighbouring sites.
Re-running it is safe and converges to the same result.

| Variable          | Default                 | Meaning                          |
| ----------------- | ----------------------- | -------------------------------- |
| `POKER_DOMAIN`    | *(required)*            | Site domain                      |
| `CADDY_CONTAINER` | `matrix-chat-caddy-1`   | Name of the running Caddy container |
| `CADDYFILE_HOST`  | `/root/matrix-chat/Caddyfile` | Caddyfile path on the host |
| `CADDY_NETWORK`   | auto-detected           | Docker network Caddy is on       |
| `HEALTH_TIMEOUT`  | `60`                    | Seconds to wait for a healthy container |

To take it down again: `bash deploy/deploy.sh --rollback`.

### Behind Cloudflare

If the domain is proxied by Cloudflare, add the `A` record as **DNS only (grey
cloud)** first so Caddy can complete the Let's Encrypt HTTP-01 challenge. Once a
real certificate has been issued, switch the record to **Proxied (orange cloud)**
and set SSL/TLS mode to **Full**. Enabling the proxy before the certificate
exists makes the challenge fail; combining it with Flexible mode produces a
redirect loop. WebSockets work through the Cloudflare proxy with no extra
configuration.

## Architecture

```
server/
  index.js      Static file server, WebSocket entry, input validation, rate limiting, heartbeat
  room.js       Seats, tokens, reconnection, timers, per-viewer redacted state snapshots
  engine.js     Single-hand state machine: blinds, betting rounds, side pots, showdown
  evaluator.js  Best five of seven card evaluation
  deck.js       Deck and cryptographically seeded shuffle
  protocol.js   Shared constants
public/         Zero-build frontend (HTML + CSS + vanilla JS)
test/           node:test suites
deploy/         Deployment script and Caddy site snippet
SPEC.md         Wire protocol and module contracts
```

The client is a pure function of server state: it consumes full `state`
snapshots and re-renders, using `event` messages only for sounds and transient
animations. Hole cards belonging to other players are redacted server-side and
only revealed as part of a showdown result — a client never receives cards it is
not entitled to see.

`SPEC.md` is the contract between the two halves and is the place to look before
changing message formats or state shapes.

## Testing

```bash
npm test
```

The suite covers hand evaluation (including a randomised cross-check against a
brute-force implementation), the betting engine (side pots, min-raise rules,
the big blind option, all-in edge cases, chip conservation as a hard invariant,
plus a randomised fuzz run), and an end-to-end pass over the real WebSocket
server.

## Known limitations

- **One table.** Running a second game means running a second instance.
- **State is in memory.** Restarting the process resets the table and every
  stack. This is a deliberate trade-off — a private game does not need a
  database.
- **No authentication.** Anyone who knows the URL can take a seat. Treat the
  URL as the secret, or put it behind your own access control.
- **Chips have no value.** There is no wagering, settlement, or payment of any
  kind, and none is planned.
- Disconnected players keep their seat for 15 minutes before being removed.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Read `SPEC.md` first if your change touches the client/server boundary.

## License

[GPL-3.0](LICENSE) © Jinzhengxu

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It comes with **no warranty**; see the license for details.
