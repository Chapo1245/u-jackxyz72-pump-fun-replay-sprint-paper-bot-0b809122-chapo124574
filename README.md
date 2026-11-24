[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Chapo1245/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-chapo124574/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Chapo1245/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-chapo124574/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Paper Bot

A paper-money momentum bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of recorded pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Most new curves are bundled launches that dump within minutes, so the bot never
buys a fresh curve and never buys a one-batch spike. A curve earns an entry in two
stages:

1. **Lifetime proof** — the curve is at least 400 slots old, its lifetime tape is
   net-positive (buys outweigh sells by 0.5 SOL), and several distinct wallets
   have bought it.
2. **Confirmed momentum** — over a 45-slot window the tape shows accelerating
   inflow (newer half beats older half), at least 6 buys from 18 distinct
   buyers, net inflow of 4 SOL, the price up 50–80% from the window start and
   sitting within 3% of the window high, with no single wallet dominating the
   buys. The signal must hold on **two consecutive batches** before any SOL
   goes in.

**Sizing:** one buy of 0.03 SOL per coin, never more. The sweep showed every
add and every larger stake only fed the losers; single small shots keep the
worst case bounded, and a runner is ridden through the trailing stop instead
of by adding size.

**Exits** (whole position): stop loss −6% vs cost, trailing stop −15% from the
peak once up 10%, hard take-profit +500% (effectively off — capping winners
at +20–30% lost more than it saved, because the rare runner has to pay for
many small losers), fade exit when 15-slot net flow turns below −0.15 SOL,
exit on any single sell of 2 SOL or more, exit when the coin stops trading
for 50 slots, and a 300-slot time limit that does not apply while the
position is up 15%.

**Guardrail pacing:** the replay requires at least 20 coins with round trips of
0.01 SOL and 200 fills, so when the bot's fills or coins lag the pace set by
elapsed block time it opens one tiny 0.01 SOL probe round trip on the most
liquid curve trading that batch.

## Files

- `main.ts` — entrypoint: runs the strategy through the SDK shim.
- `strategy.ts` — the momentum strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/agentfun-bot.ts` — the kit SDK shim, vendored byte for byte.

## Run

```sh
node main.ts
```

Node 22.18+ runs the TypeScript as-is; no dependencies, no network, no secrets.

## Local verification

Graded with the kit's own grader (`grade-local --driver process`) on the dev
window, then stress-tested on rebuilt copies of the window. See `REPORT.md`
for the dev score, the stress median/p10/p90, and the losing-copy share.
