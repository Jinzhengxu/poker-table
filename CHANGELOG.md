# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A spot bank: measuring the model's judgement instead of its luck.** `npm run eval`
  answers "how much money does range modelling win"; that number is buried under variance
  and needs tens of thousands of hands. What we actually wanted to know — *does the model
  judge well* — does not require playing at all. `server/eval/spots.js` freezes 20 board
  states with a verdict attached, `scripts/agent-eval.mjs` puts a driver through them and
  scores the answers. Zero variance, a conclusion in twenty calls.

  The same bank runs against all three drivers — `--mode rule` (free, deterministic, the
  floor), `--mode single` (the old one-shot path), `--mode agent` (the tool loop) — which
  is the only way "what did this round of agent work buy" has an answer.

  Verdicts are written wide on purpose: `forbid` ("holding a straight flush you may not
  fold") rather than `allow`, because poker's *best* line is arguable while its *blunders*
  are not. Write the verdict narrow and you measure the author's poker, not the model's.

  The highest-signal entries are the **paired** ones: same hole cards, same board, same pot
  odds, and the only variable is who the opponent is — one pair differs in the betting
  line, the other only in a profile seeded from 12 prior hands (VPIP 8% vs 83%). If range
  modelling is doing anything, the two answers must differ. A single spot can never show
  this: watch it fold and you cannot tell "read the opponent as tight" from "folds a lot".

  `test/spots.test.js` guards the bank itself — duplicate cards, board length against
  street, that every "nuts" spot really is the nuts (checked through the real evaluator),
  that paired spots vary in exactly one dimension, and that paired calling spots **can
  actually flip**: equity below the break-even under a 5% range and above it under 35%.
  A bank with a typo in it fails the model and reports it as the model's fault.

  Three more guards came out of auditing the bank itself, and each one had already
  cost a wrong conclusion:

  **The pot may not be hand-written.** The engine's `totalPot` includes the opponent's
  outstanding bet; the bank mixed both conventions, and 26 of 41 spots had a pot that
  contradicted their own action history — one by a whole turn bet, so the verdict was
  written for 33% while the model was shown 50%. The pot is now derived the way
  `engine.js#totalPot` derives it, and a test reconciles pot, history and seat
  contributions, all three of which go into the prompt verbatim.

  **A trivial strategy must not score well.** Written mostly as "may not fold", the
  verdicts let a bot that never looks at its cards and always min-bets score 75%, against
  93–100% for the real drivers: all the discrimination lived in the top quarter, and rule,
  single-shot and agent piled up together there. A whole category of spots where
  *aggression* is the error now exists (check down bottom pair, don't raise second pair,
  don't 4-bet AJo, don't bluff a station, don't fire into two players), the report prints
  the five trivial baselines every run — without that floor the accuracy number cannot be
  read — and a test caps the floor at 72% so the next batch of "may not fold" spots fails
  loudly.

  Both of the earlier guards were written after being caught out too. The profile pair was first
  written with the opponent named "the rock" and "the maniac", and the memoryless
  single-shot driver separated it too — it was reading the name, so that version measured
  whether the model knows two Chinese words. And the first betting-line pair was top pair
  AQ facing a river barrel, on the reasoning that a nit firing three streets beats top
  pair — until the equity tool said AQ is 70% there even against a 5% range. There was no
  fold in that spot at all: the model called both sides correctly and the report scored it
  as failing to read the opponent. Every pair is now verified against the equity tool
  before it goes in.

  Results against `deepseek-v4-flash` (46 spots × 2, 33 of them scored), counting only
  decisions the model actually answered — a fallback runs the rule policy, so mixing the
  two reports neither one's score:

  | | rule | single-shot | agent | agent, no `plan_bet` |
  | --- | ---: | ---: | ---: | ---: |
  | verdicts | 94% (31/33) | 98% (58/59) | 94% (58/62) | 97% (63/65) |
  | per-spot, both passes | 94% | 97% | 88% | 97% |
  | 95% interval | 80–98% | 84–99% | 73–95% | 85–99% |
  | fires | 15% | 38% | 54% | 39% |
  | shoves | 0% | 7% | 6% | 11% |
  | paired spots separated | 0/4 | 0/8 | 3/8 | 5/8 |
  | p50 latency | 0.1s | 6.0s | 35.0s | 25.0s |
  | over the 30s gate | 0% | 0% | 77% | 28% |

  **The accuracy row separates nothing.** With 33 scored spots one spot is three points and
  every interval overlaps. That is a statement about the bank's resolution (±2 spots), not
  about the models, and it is why the conclusions below rest on things that can be counted
  without a verdict.

  **This round of agent work still is not buying accuracy.** It costs 5–6× the latency and
  an order of magnitude more tokens than the single-shot path and scores no better. The one
  column where the loop clearly beats single-shot is the paired spots — 3/8 to 5/8 against
  0/8 — so the tools do let it *see* the opponent difference; that has just not turned into
  a better score yet.

  Where it beats the rule policy is directional and worth keeping: both of the rule
  policy's errors are in `size` (no c-bet on a dry board, no protection bet on a wet one) —
  it never fires on its own, 15% fire rate and 0% shoves — and all three model lines get
  the sizing spots right. The model's errors run the other way, toward firing too much.

  An earlier draft of this entry reported the agent separating a profile pair 3/3. That
  result is withdrawn: the pair was unflippable, and "separating" it meant folding a hand
  that is a call against any range. The flippability check exists because of it.

- **Tool ablation (`--exclude`), and what it says about `plan_bet`.** The bank makes a
  question askable that could not be asked before: *is this tool worth having?*
  `--exclude plan_bet` drops it from the tool set **and from the system prompt** — the
  prompt is now generated from the tool names, so the two can no longer disagree and no
  ablation can leave the model reaching for a tool that isn't there. `act` cannot be
  dropped; it is the loop's only exit.

  Counting only decisions that actually completed the agent loop (fallbacks run the rule
  policy, which never shoves, so a higher fallback rate deflates the shove rate
  mechanically), the tool costs 5.1 steps and 6.1 tool calls per decision against 3.6 and
  3.8 without it, 18.1k input tokens against 8.2k, and a p50 of 35.0s against 25.0s — which
  is the difference between 77% and 28% of decisions blowing through the 30s gate. Verdicts
  are 94% with against 97% without, which given the bank's ±2-spot resolution says nothing.

  What the ablation does establish is **direction**, and it is paired, not eyeballed. Across
  the 82 decisions runnable on both legs: fires 43 vs 33, and split by pair, **14 decisions
  fired only with `plan_bet` against 4 that fired only without it** (McNemar exact, two-sided
  *p* = 0.031). Same spot, same pass, same model; the tool is the only variable.

  The errors say the same thing in plain sight. With `plan_bet`, all four wrong answers are
  over-firing — raising a gutshot, raising river air, 4-betting AJo, betting a river bottom
  pair that should check down. Without it, both wrong answers are over-calling middle pair
  in a three-way pot. The tool did not change whether the arithmetic came out right; it
  changed which way the mistakes lean. And within the `plan_bet` leg, **calling the tool and
  firing are nearly the same event**: 70% (45/64) of decisions that called it fired, against
  0% (0/20) of those that did not. That correlation alone is causally ambiguous — it may
  reach for the tool because it already wants to bet — but the paired ablation settles the
  direction.

  The paired-spot column falls from 5/8 to 3/8 with the tool present, which says the cost is
  also a **budget fight**: with five tool calls available, three spent ranking bet sizes
  leave none for "price it against a tighter and a looser range", which is what the prompt
  asks for two steps earlier. Those two instructions compete for the same budget and
  nothing had ever measured which one pays better.

  Boundary on this result, and it matters: **no spot in the bank punishes a bad bet size.**
  The sizing verdicts check whether it fired at all and clamp the amount to a wide band;
  none of them check that it picked the EV-maximising size, which is the thing `plan_bet`
  exists to do. So the ablation measures the tool's cost cleanly and mostly cannot see its
  benefit. Spots that punish sizing come first; deleting anything comes after.

  One operational finding with no code change behind it: `POKER_AGENT_MAX_MS` defaults to
  30s against a 45s action deadline, budgeted for a model that answers in a second or two.
  With a reasoning model the measured p50 is 35s and p95 56s (33s p50 run serially, so not
  a concurrency artifact) — 77% of decisions would be cut off mid-loop, having paid for
  every step. The budget is also divisible: dropping one tool takes p50 to 25s and the
  over-gate share to 28%, so the latency is per tool call, not a fixed cost of the loop.
  Raise both budgets, drop `POKER_AGENT_MAX_STEPS` to 3–4, cut tools, or run the agent path
  on a non-reasoning model.

- **`plan_bet`: the agent's tool set now speaks the other half of poker.** The first
  version spoke only one language — calling. `estimate_equity` returns equity and a
  break-even percentage for a call; every number was a calling number. But roughly half
  the money in poker comes from firing, and on that side the model had nothing, so bet
  sizes were vibes. The step from "he folds to 55% of bets" to "two-thirds pot needs him
  to fold 40%" is arithmetic models get wrong in one direction: they underestimate the
  fold frequency required, and fire too often.

  The formula is the mirror image of pot odds — **required fold % = loss / (pot + loss)**,
  where the loss already subtracts what you win back on the times you get called. That
  subtraction is the entire content of the word "semi-bluff": into a 100 pot, betting 100
  as a pure bluff needs 50% folds; the same bet holding a draw worth 30% equity needs 9%.

  Given `opponent_range` as well, it also reports how often he actually folds
  (`1 − continue/current`, raised to the number of opponents) and `ev_chips` for the size.
  `ev_chips` exists because `needs_fold_pct` cannot rank sizes: with a strong hand it
  reads 0 for a third-pot bet and for a shove alike.

  Two modelling assumptions, stated in the tool description because the model has to know
  them: the baseline is "if you don't bet you get nothing", so `ev_chips` compares sizes
  against each other and never against checking; and the pot maths assume a single caller,
  so equity is computed against one opponent to match — optimistic in a multiway pot,
  which the result says out loud.

- **Range ordering now sorts by playability tier first, equity second.** Equity alone
  answers "how strong is this hand"; `opponentRange` asks "which hands would they
  play". Measured against real opening charts at matched combo counts, equity-only
  ordering overlaps CO opens by just 75%, and the disagreement is entirely
  one-directional — it adds offsuit high cards (A9o A8o K9o A5o) and drops suited
  connectors and small pairs (76s 65s 54s 98s 22 33). 76s ranks 116/169 by equity yet
  appears in every CO chart; K9o ranks 40th and appears in none.

  `server/bot/data/ranges.js` assigns each of the 169 hands one of 12 playability
  tiers, read off a nested ladder of real ranges from "still jamming over a 4bet"
  (1.2%: AA/AKs/KK) out to "big blind defending a small blind open" (65%). Generated
  by `scripts/build-preflop-ranges.mjs`, which self-checks (169 hands present, tier
  bounds monotone, 76s ahead of K9o) and refuses to write on failure.

  Overlap with real ranges, held-out charts only (31 charts that took no part in
  building the ladder): **72.9% → 86.9%**.

  Provenance: tiers derive from [AHTOOOXA/poker-charts](https://github.com/AHTOOOXA/poker-charts)
  (MIT), `greenline.ts` at commit `85ad2041`, which states it was extracted from
  GreenCharts2024_01.pdf (Greenline Poker). The underlying charts are a third party's
  work and relicensing them may not have been upstream's to do; we take only the tier
  assignment and redistribute no original presentation. See the generator's header.

- **Opponent profiles are split by position.** Position is the strongest single
  predictor of a preflop range — the same player's entry rate from under the gun and
  from the button can differ by more than 2×, and pooling them describes neither.
  `positionOf()` buckets seats into `blinds` / `late` / `middle` / `early` by distance
  from the button (tables are 2–8 handed, so 6-max position names do not apply). Only
  preflop stats are split; postflop aggression reads as temperament and quartering its
  sample would buy noise. `read_opponents` adds a `here` field naming the opponent's
  bucket *this hand* plus their history in it. Position is derived from `isSB`/`isBB`
  when available and from `isButton` otherwise — the former go false once the hand
  ends, which is exactly when `#finishHand()` calls `observe()`.

### Fixed

- **The eval runner scored the rule policy as if it were the model.** `BotDriver#decide`
  falls back to the rule policy whenever the provider call throws, leaving no trace but
  `source: 'rule'` — and the runner silences the driver's logger, so even that one log line
  went nowhere. The runner discounted fallbacks in `agent` mode only, so in `single` mode
  the rule policy's answers were folded into "the single-shot accuracy". One run had 30 of
  92 decisions answered that way: a third of a reported 98%. Worse than the accuracy, it
  moves the aggression columns in a direction that looks like good news — the rule policy
  never shoves, so every hidden fallback deflates the shove rate.

  `modelAnswered(mode, source)` now defines the rule once for all three modes, the report
  always prints a "model's own answers only" row when anything fell back, and the runner
  captures the driver's error lines so a fallback says why (the eight in the re-run were
  all `fetch failed` — gateway flakiness, not content filtering). `test/bot.test.js` feeds
  a real driver's return value through the predicate in both the success and the
  provider-error case, so the two cannot drift apart again.

- **The single-shot path silently degraded to the rule bot on any reasoning model.** Its
  token budget was hard-coded to 200 — plenty for the twenty-token action JSON, and
  nowhere near enough once a model thinks first, because the chain of thought is drawn
  from the same budget. What comes back is either JSON truncated mid-string or an empty
  `content`, both of which throw, and every hand quietly falls back to the rule policy.
  The log line reads "could not parse JSON": it looks like a dim model, not a
  configuration bug. The spot bank put a number on it — 18 of 20 spots lost this way at
  200, still 12 of 40 at 1024. Measured against `deepseek-v4-flash`, reasoning alone runs
  572–3372 tokens on these spots, so the default is now 4096 and `POKER_BOT_MAX_TOKENS`
  overrides it. Raising the cap costs nothing: you pay for the thinking tokens either way,
  and the cap only decides whether that spend buys an answer.

- **"Under the gun" is now called `前位`, because the old name got every agent request
  rejected.** Chinese LLM gateways run a content filter in front of the model, and it
  scans the tool definitions too. The two characters in the old term read as a firearm
  word, so `positionName()` — whose output goes verbatim into the prompt — returned an
  HTTP 451 for any six-handed table where somebody sat there. The failure is the quiet
  kind: the table plays on, the bot just turns into the rule bot, and the fallback rate
  climbs where nobody is looking. `isContentFilterError()` now names this class of failure
  separately (`stats.filtered`), and a test scans the whole prompt surface — system
  prompts, tool descriptions, parameter descriptions, every position name at every table
  size — against the words we have actually been rejected for.

  Worth knowing before deleting words in a panic: there is a second, intermittent kind.
  In a multi-step loop the model's own chain of thought and tool arguments are sent back
  up, and those get scanned as well — the same spot passed three times and was rejected
  once with nothing changed on our side. Rejected every time means our text; rejected
  occasionally means the model's, and editing our prompt will not help.

- **The agent's prompt no longer asks for JSON and tool calls at the same time.** Both
  paths share `buildUser`, whose closing line was "output your decision (json)" — correct
  for the single-shot path, in direct conflict with the agent's system prompt, which says
  to submit through the `act` tool and emit no prose. The likely failure was the expensive
  one: the model writes a JSON blob as text, `readAct` returns null, a whole multi-step
  loop is burned, and the decision falls back to single-shot anyway. `buildUser` now takes
  `forTools`, and the two paths close differently.

- **Cancelling a bot's turn is no longer counted as a model failure.** When a hand ends, a
  bot is kicked, or the table resets, `Room#cancelBot()` aborts the in-flight decision.
  That abort surfaced as a rejection, was charged to the model's health record, and three
  of them put the agent path into a 60-second cooldown — during which the model may have
  been working perfectly. It also triggered the fallback path, spending a second LLM call
  on an action the room had already discarded (and damaging `BotDriver`'s own health
  record on the way). Cancellation is now detected up front, counted separately as
  `stats.canceled`, and returns a rule action without another call.

- **The agent's wall clock now reaches inside its tools.** `buildTools` received the
  external cancel signal rather than the composed "timeout or cancel" signal, so when the
  20-second gate fired it stopped `generateText` but not the Monte Carlo run in flight,
  which went on burning its full budget for a decision nobody wanted.

- **A bot's opponent profile is now dropped when it leaves the table.** Profiles are
  keyed by nickname, and bot nicknames come from a fixed pool of twenty in
  `persona.js`. Without the drop, the next bot to draw "老陈" inherited the previous
  老陈's VPIP, fold-to-bet and showdown history — with a completely different randomly
  drawn persona. The name pool is barely larger than the table, so on a long-running
  server this was a certainty, not a coincidence. `Room#vacate()` calls the new
  optional `botDriver.forget?.(name)`; humans are deliberately exempt, since they pick
  their own names, reconnect, and should keep their profiles.

- **`runMatch` zero-sum test no longer compares rounded values with strict equality.**
  `Math.round` breaks ties toward +∞, so a true value landing exactly on a half-cent
  rounds to `+70.63 / −70.62`. The invariant held; the assertion was wrong. It now
  allows one rounding step.

### Changed

- **The agent's step budget went from 4 to 6, and its wall clock from 20s to 30s.** Tool
  calls available are `maxSteps − 1`, since the last step is forced to `act` — four steps
  bought three tool calls, enough for "read the profile, compute equity, plan one bet
  size", but not enough to compare sizes against each other, which is the only way
  `plan_bet`'s `ev_chips` is useful. Six buys five. This raises a ceiling, not a cost: the
  loop stops the moment `act` is called, and most decisions still end in two or three
  steps — what grows is the headroom on the hardest ones, which is where the money is.

  The wall clock had to move with it or the extra steps would be unusable, with the gate
  falling mid-loop and discarding everything already paid for. 30s gate + 1.5s fallback
  equity + 8s fallback model call ≈ 40s, which stays inside the 45s action timeout with
  5s of slack. Past that, raise the action timeout first.

- **bb/100 is significant for the first time.** 9,000 decks / 18,000 hands, six-handed,
  playability-tier ordering with the recalibrated constant: **+16.04 ± 9.22 (seed 1,
  p=0.0007)** and **+13.67 ± 9.49 (seed 2, p=0.0018)**, pooled **+14.9 ± 6.6**, z=4.4.
  Previously the same harness could only show that the sign had gone from consistently
  negative to consistently positive.

  **The credit cannot be split between the two changes.** The ablation (new ordering, old
  constant) gave +1.49 ± 9.99 on seed 1 — nowhere near significant, which nearly produced
  the conclusion "the constant did the work, not the ordering" — and +14.28 ± 8.98
  (p=0.0018) on seed 2. Identical code, 12.8 bb/100 apart, larger than the effect being
  attributed. Its pooled interval overlaps both neighbours.

  Caveat, now load-bearing: the constant was tuned against the rule bot's own population,
  which never bluffs preflop, so "assume tighter and fold more" is nearly free against it.
  The number is in-sample in that sense and is not a claim about play against humans.

- **Range heuristic recalibrated for the new ordering.** "Top X%" now denotes a
  different set of hands, so the constants fitted against the equity ordering were
  stale by construction. Recalibrating found that the ordering change *by itself*
  fixed the tight end (the bucket that was 4× too tight now reads 1×), leaving one
  systematic error: a single raise was inferred too loose (claimed top 35%, opponents
  actually held top 10%, consistent across three seeds). `FIRST_SHRINK` 0.35 → 0.22,
  deliberately **not** fitted all the way to 0.10 — the calibration population is the
  rule bot itself, which has a fixed handStrength threshold and never bluffs preflop,
  so "someone raised" is equivalent to "they have it" for that population alone.
  `FLOOR` was tried at 0.06 and reverted to 0.12 on measurement: the top-5% bucket
  immediately went 2–4× too tight again. Worst deviation 3.3× → 2×.

- **Range ordering previously used real preflop equity, not the Chen formula.**
  `server/bot/data/preflop.js` holds each of the 169 starting hands' equity against
  one random opponent, generated by `scripts/build-preflop-equity.mjs` from this
  project's own `evaluator.js` (one million simulations per hand, fixed seed). The
  generator refuses to write the file if it deviates more than one point from
  published figures, and the anchors are pinned by a test. "Top X%" now has an exact
  meaning: the top X% of combos by equity.

  Effects on the shadow evaluation, same seed, ordering as the only variable:
  decisions changed 11.5% → 14.0%, median equity revision 9.2 → 9.8 points,
  noise floor 0.9% → 0.7%, and the fold/call direction ratio sharpened 6:1 → 8.9:1.

- **The rule fallback now uses range-aware equity too.** `BotDriver` infers a range
  from the action sequence before estimating equity, instead of assuming random
  cards. The call decision compares equity to pot odds, so feeding it an
  optimistic number made the bot call hands it should fold. The prompt's stated
  modelling assumption follows the actual one (`buildUser` branches on
  `equity.range`) — hardcoding "random two cards" would have the model discount an
  already-discounted number twice. When the agent's action is unusable, it now
  routes to `BotDriver` rather than to `coerceAction`'s equity-less rule fallback.

- **Calibration check (`npm run eval -- --calibrate`).** Inside the harness we hold
  the engine's full information, so we can ask where opponents' actual cards rank
  when the heuristic claims a range. Every live opponent at every decision is one
  observation — two orders of magnitude less variance than bb/100, and the only
  direct way to falsify a range inference.

  It caught a real error: the first heuristic was **4× too tight** at the top-5%
  bucket while simultaneously 2.2× too loose after a single raise. One explanation
  covers both — the first act of aggression carries most of the information and
  later ones add much less, while a multiplicative model compounds them equally.
  Recalibrated (first attack 0.35, later ones ×0.8, floor 0.05 → 0.12), the worst
  error fell to 2× and the largest bucket now lands exactly. bb/100 followed:
  −7.54 → **+6.23** (seed 1) and **+3.15** (seed 2), pooled ≈ +4.7 ± 6.9 — the sign
  went from consistently negative to consistently positive, though the interval
  still spans zero and no significant difference has been measured. The heuristic's
  constants are pinned by a test asserting no bucket exceeds 3× too tight.

  This function must never be referenced by runtime code: it reads opponents' hole
  cards, which a bot at the table must never have. It lives only in `server/eval/`,
  which is not copied into the image.

- **Self-play evaluation harness (`npm run eval`, `server/eval/`).** Ablates one thing:
  same rule policy, same decks, same random stream, with equity computed either
  against random cards or against a range inferred from the action sequence
  (`bot/range.js`).

  Two variance-reduction techniques carry it. **Duplicate dealing**: each deck is
  played twice with policies rotated one seat, so card luck cancels between the
  arms. **A deck, not a hand, is the independent unit**: the two replays of one
  deck are strongly correlated by construction, and counting hands would inflate
  the sample size twofold and shrink the confidence interval into fiction.

  `--shadow` adds a much lower-variance measurement: drive the hand with the
  existing policy, and at every equity-relevant decision compute both assumptions
  and record whether the range assumption would change the call.

  What it found, both halves: where the heuristic narrows the range (1,125
  decisions), **11.5% of actions change**, equity is revised down by a median of
  **9.2 points**, and the direction is **139 "call → fold" against 23 the other
  way** — as theory predicts, reproducible across seeds. But bb/100 **does not
  resolve**: +11.51 ± 21.31 over 2,000 decks and −5.81 ± 11.35 over 9,000 decks
  from the *same random stream*, so the point estimate flipped sign as the sample
  grew. The first number was noise, not a near-miss.

  Reporting deliberately makes that hard to fudge. Every run prints a confidence
  interval; a non-significant result is labelled "没测出差别" (no difference
  measured), never "tied"; and the harness computes how many more decks
  significance would need, with the caveat that an underpowered point estimate
  changes sign. The shadow mode also reports its own **measurement noise floor**
  (0.9%: two Monte Carlo runs on the identical code path disagreeing purely from
  sampling), so the 12% figures are read against 0.9% rather than against zero.

- **`bot/range.js`** — deterministic opponent-range inference from the action
  sequence, used only by the evaluation harness. Deliberately dumb (it counts how
  often opponents attacked and nothing else) so the ablation measures range
  modelling itself rather than a model's judgement. Its blind spot is documented:
  it infers nothing preflop without a raise, which is 77% of equity decisions.

- **`actionHistory(events)` exported from `server/engine.js`** — the per-street
  action sequence transform, previously private to `Room`. Blinds and antes are
  `blind` / `ante` events rather than `action`, so VPIP statistics never have to
  separate voluntary money from posted blinds. Now shared by the snapshot, the
  bot prompt and the harness.

- **Agent mode for bots (`POKER_AGENT=on`, off by default).** The bot goes from
  one model call to a multi-step tool loop built on the Vercel AI SDK.

  What it actually fixes: single-shot mode computed equity *for* the model and
  pasted it into the prompt with the assumption hard-coded to "opponents hold two
  random cards" — a systematically optimistic number the model had no way to
  question. Equity is now a tool, and the model supplies the range. AKo preflop
  against one opponent is ~66% against any two cards but only ~47% against a
  top-5% range; same hand, same pot odds, and the conclusion flips from call to
  fold. (AA is ~83% under every assumption, because it is already ahead of
  everything — also correct.)

  Three tools: `estimate_equity` (Monte Carlo under a caller-supplied range),
  `read_opponents` (cross-hand profiles), and `act` (the loop's only exit — it
  executes nothing and calling it stops the loop). Pot odds, position and the
  action sequence stay in the prompt; spending a tool round-trip on arithmetic
  would only add latency and failure surface.

  It wraps the existing driver rather than replacing it. Step budget exceeded,
  wall clock exceeded, model without function calling, packages not installed —
  every failure lands on `BotDriver.decide()` (single-shot LLM → rule policy →
  always legal). All three bot safety rules are unchanged, and behaviour with
  every external service down is exactly what it was before.

  Costs, stated plainly: 2–4 model calls per decision, roughly 3× the tokens, a
  few seconds more latency, and `ai` / `@ai-sdk/openai-compatible` / `zod`
  (~21 MB) for that path only. The table still depends only on `ws` — those are
  loaded via a dynamic `import()` and the server falls back if they are absent.

- **Range-aware equity estimation (`opponentRange` in `bot/equity.js`).** Opponent
  hands can now be sampled from the top X% of starting hands (ranked by Chen
  score) instead of uniformly from the deck. Reported alongside the estimate so
  callers can tell the model which assumption produced the number — `61%` against
  random cards and `61%` against a tight range are very different claims.

  The ranking is an approximation and documented as one: Chen is a heuristic, not
  a true equity ordering, and ties within a score band are cut arbitrarily.

- **Cross-hand opponent memory (`agent/memory.js`).** VPIP, PFR, postflop
  aggression, fold-to-bet and recent showdowns, accumulated per player name
  across hands. Built entirely from the redacted snapshot: betting stats come
  from the action history during a decision (idempotently, so deciding several
  times in one hand never double-counts), and showdown cards from a single
  `observe()` call the room makes when a hand ends — the only moment opponent
  hole cards are visible at all. Reports nothing below six hands of sample.

- **Hotword (`/hotword`), a third game.** Two players race to guess the same
  hidden Chinese word; whoever gets it first wins, and everyone else watches.
  Every guess comes back with its closeness rank among all 52,728 vocabulary
  words — meaning, not spelling, so 护士 lands next to 医生 while 西瓜 does not.

  Ranks, not similarity percentages: the cosine scale differs per target word
  (the nearest neighbour of 咖啡 is 0.80, of 台风 only 0.63), so a percentage
  would tell a player they are far off when they are as close as anyone can get.

  The asymmetry is the game. You see your own words and exact ranks; your
  opponent and the audience see only your guess count and a temperature bar.
  Fully public and the second player free-rides; fully hidden and it is two
  people playing solitaire. `Peek` buys the opponent's best guess so far — not
  their most recent, which is usually just a probe in a new direction — for 8
  frozen seconds, twice per round, and it is announced in the log. Guesses carry a
  1.5-second cooldown, which is what keeps the winner the player who thought
  correctly rather than the one who types fastest.

  A round is capped at **90 seconds**, counted down in the top bar; if neither
  player gets it, the round is a draw and the answer is revealed. Nothing bounded
  a round before, so two players who both stopped guessing could sit there forever.

  Hints (length, category, first character) unlock **on the clock** — at the start,
  at 23 seconds, and at 54 seconds of a 90-second round — identically for both
  players, with no relationship to how much anyone has guessed. The tier times are
  stored as fractions of the round length, so a host who stretches a round to five
  minutes stretches the tiers with it instead of having all three fire at once.

  This took three attempts, and the two dead ends are the reason for the design.
  Unlocking on **your own** guess count (10/20/30) had a dominant strategy: a guess
  costs only its cooldown and any vocabulary word counts, so 87 seconds of typing
  nonsense bought all three tiers — and the three together are not a hint but the
  answer, uniquely identifying 92% of the answer pool. **Sharing** the hints and
  freezing whoever pushed a tier for 8 extra seconds inverted that exploit, but
  taxed playing well: someone working down the candidate list after the category
  hint trips the first-character tier on their 11th try and hands it over. The
  engine counts guesses; it cannot tell grinding from thinking. Both players end up
  parked at 19 guesses, and the anti-stalemate valve becomes the one thing nobody
  will ever volunteer to open — the stalemate locks itself in. Unlocking on time
  removes the choice from both players: the clock cannot be rushed or stalled, so
  guessing goes back to being pure private upside and the valve opens by itself.

  The tiers are ordered by measured give-away over all 403 answers: length narrows
  403 → 311 candidates and pins down 0.2% (350 answers are two characters, so it is
  nearly free and there is no reason to withhold it), category narrows to 25, and
  the first character alone narrows to 1.6 and uniquely identifies 65.5%. Category
  is the pacing lever: knowing it, the best same-category word lands at median rank
  5 and inside the top 100 for every answer tested.

  Chinese needed one rule English Semantle does not: words that contain the
  answer or are contained by it are dropped from the round's vocabulary and
  reported as unrecognised. With 咖啡 as the answer, 8 of the top 50 neighbours
  are 咖啡厅/咖啡豆/咖啡馆/…, and one lucky guess would end the round.

  Words come from Tencent AI Lab's Chinese vectors (Apache-2.0), filtered to
  pure-Han 2-4 character words in the top 60k by frequency and quantised to
  int8: 10.8MB on disk, ~11MB resident, 99.6% top-1000 rank agreement with
  float32. A rank table is built once per round (~65ms) so each guess is an O(1)
  lookup. Answers are drawn from a hand-picked list of 400 everyday words.
  `scripts/build-hotword-data.mjs` regenerates the data; `HOTWORD_DATA_DIR`
  points at a different word pack. Missing data files leave the page usable and
  the game unstartable rather than taking hold'em and guandan down with them.

- **Background music is now a small shuffled playlist** of three Kevin MacLeod
  blues/lounge tracks (CC BY 4.0) instead of one 8:50 ragtime loop. Same idea as
  the music in Apple's Texas Hold'em — laid-back country-lounge — since that
  soundtrack itself is Apple's and cannot be redistributed. `app.js` shuffles the
  order each pass and never plays the same track twice in a row; adding a track is
  one line in `TRACKS`. Attribution is required by CC BY and lives in the settings
  panel as plain text (an outbound link would break the tab disguise and trip the
  "no external resources" test).

  All three are normalised to -18 LUFS **after** the mono downmix, not before —
  measuring in stereo and then `-ac 1` costs a wide mix up to 3 dB and leaves the
  tracks mismatched. `public/music/README.md` has the two-pass recipe.

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

- **Hotword's `下擂台` button was unreachable on a phone.** It only rendered in
  the lobby block, which is hidden while a round is playing, and the moment a
  round ended the result screen — a full-screen fixed layer whose only control
  was `再来一局` — covered it. So the button existed for exactly the frames
  between one round ending and the next starting: visible, and impossible to
  hit. A player who wanted their seat back had to close the tab.

  Three changes. `下擂台` now sits in the tool row next to `偷看` and `认输`, so
  it is reachable mid-round (the server already voided the round for anyone who
  left mid-game; only the client hid the button). The result screen gained a
  close button, and a dismissed result stays dismissed until the next round
  starts — so the arena and its seat controls underneath are reachable, which
  also unblocks a spectator trying to sit down after a round ends. And the
  result screen itself carries `下擂台` beside `再来一局`, since that is where a
  player who has just lost is actually looking.

  The result box was also half a screen wide on phones: `.result-overlay` is a
  grid with `place-items: center`, so its implicit column was sized to content
  and the box's `width: min(560px, 100%)` resolved `100%` against that instead
  of the viewport. Pinning the column to `minmax(0, 1fr)` gives the box its full
  width back, and the action row is `position: sticky` so a long word-by-word
  comparison cannot push the buttons below the fold.

- **Hotword had no way in from the other two tables.** `/hotword` linked out to
  both poker pages, but neither linked back, so the only way to reach the new
  game was to type the URL. Both tables now carry a 🔥 热词 link in the top bar.

  Six controls do not fit a 390px top bar next to the hand number and blinds, so
  on phones the two cross-table links drop their pill shell and render as bare
  glyphs. That buys back the ~30px the blinds need, and it makes navigation read
  as a different kind of thing than the sound/music/mic toggles beside it.

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
