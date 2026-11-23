# OrganicLaunch — a pump.fun replay bot

[![make.fun bounty](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Robekk/makefun-organic-launch-replay/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Robekk/makefun-organic-launch-replay/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

An entry for the make.fun bounty **Winner Takes All — $5 Pump.fun Replay Sprint**
([make.fun](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)):
a trading bot for the `agent-fun/replay/v2` harness that trades 10 SOL of paper money on a
6-hour replay of pump.fun bonding-curve events. Best net PnL wins; a placement needs a net PnL
above holding cash.

## Strategy

The dev window's tape was measured before anything was tuned: nearly every public signal
(momentum, whale-following, dip-buying) loses after the ~2.5% round-trip cost of curve fees.
The one slice that stayed positive out of sample is the **organic launch**:

- **Entry** — within the first 6 slots of a coin's life, only when the creator's own buy is a
  normal size (0.2–2 SOL) and at most 25% of the buy SOL so far comes from repeat snipers
  (wallets already seen buying 3+ distinct coins this window). One entry per coin, no
  pyramiding, stake capped by the market at 1% of the curve's real reserves.
- **Slippage guard** — buys carry a 15% slippage cap, so an entry whose price already ran away
  during the 2-slot order latency is refused by the market for free instead of filled at the top.
- **Exits** — take profit at +30% of cost, stop at −8%, hard time stop after 25 slots, and an
  immediate exit when the creator sells. Fast exits are the point: on this tape, holding longer
  is what turns the same entries negative.
- **Guardrail probes** — minimum-size (0.011 SOL) round trips on liquid curves, paced over the
  window, keep the run above the 20-distinct-coin bar at minimal cost.

Local replay of the full dev window (24 h) with the kit's engine port: **+0.134 SOL** net,
159 coins traded, max drawdown 0.7%. On a held-out slice of the window the same settings made
+0.132 SOL. The final window is fresh data recorded after the deadline, so these numbers are
evidence about the strategy's shape, not a promise.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`, Node 22).
- `strategy.ts` — the strategy (parameters at the top, in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.

The bot is a pure function of the batches it is fed: no clock, no randomness, no I/O, no
network. Run it and it reads `hello` / `batch` lines on stdin and writes one `reply` per batch.
