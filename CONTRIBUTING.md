# Contributing

Thanks for taking a look. This is a small project with a deliberately small
surface — the goal is a private poker table that runs on a 1 GB VPS, not a
platform. Changes that keep it small are the easiest to merge.

Issues and pull requests in English or Chinese are both fine.
中英文提 issue 和 PR 都可以。

## Before you start

Read [`SPEC.md`](SPEC.md) if your change touches anything between the client and
the server. It defines the message formats, the state snapshot shape, and the
module contracts. The two halves were implemented independently against it, so a
field renamed on one side silently breaks the other.

## Setup

```bash
npm install
npm start          # http://localhost:8080
npm test
```

Node 22 or newer. The only runtime dependency is `ws`, and the frontend has no
build step — edit the files in `public/` and reload.

To exercise a real multi-seat game locally, open two different browsers, or one
normal window plus one private window. Two tabs in the same browser are treated
as the same player on purpose.

## What CI checks

Every push and pull request runs:

- `npm test` on Node 22 and 24
- `node --check` over every `.js` file in `server/`, `public/`, and `test/`
- `shellcheck` on `deploy/deploy.sh`
- a Docker build, followed by booting the image and hitting `/healthz`

Please make sure `npm test` passes locally before opening a PR.

## Ground rules for changes

**No new runtime dependencies.** `ws` is the only one, and the frontend loads
nothing from the network — no CDN, no webfonts, no images. Cards are drawn in
CSS. A PR that adds a dependency needs to argue for it.

**Game logic changes need tests.** `server/engine.js` is the part most likely to
be subtly wrong, and poker has a lot of edge cases that only show up with real
money on the table. The existing suite treats chip conservation as a hard
invariant and fuzzes randomised games; keep it that way. If you fix a rules bug,
add the hand that reproduced it as a test with an injected deck.

**Never leak hole cards.** `Room#buildStateFor` redacts every other player's
cards before the snapshot leaves the server. Cards are only revealed as part of
a showdown result. Any change that moves card data around needs to preserve
this — a client must never receive cards it is not entitled to see.

**Keep the UI usable on a phone.** 360 px portrait is the target. No horizontal
scrolling, and action buttons stay at least 44 px tall.

**Comments and user-facing text.** Existing code comments are in Chinese and the
UI is Simplified Chinese. Match the surrounding file rather than mixing
languages within one.

## Commit messages and PRs

Describe what changed and why. If it fixes a bug, say how it reproduced. Small
focused PRs get reviewed faster than large ones that do several things.

## Reporting bugs

Use the issue templates. For a rules or payout bug, the most useful report
includes the hand: seats, stacks, blinds, and the sequence of actions. That
usually converts straight into a regression test.

Security issues go to [SECURITY.md](SECURITY.md) instead — please do not open a
public issue for those.

## License

By contributing you agree that your contributions are licensed under the
[GPL-3.0](LICENSE), the same license as the project.
