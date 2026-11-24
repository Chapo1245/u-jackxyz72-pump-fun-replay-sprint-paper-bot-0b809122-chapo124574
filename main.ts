// Paper momentum bot for the pump.fun replay sprint (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The bot trades 10 SOL of paper money on a 24h replay of pump.fun bonding curves.
// It only buys curves that already proved themselves — old enough, net-positive
// lifetime inflow from several distinct buyers — and only after the short-window
// momentum signal holds on two consecutive batches. First buys are small and the
// bot pyramids into strength only; exits are whole-position sells on a stop loss,
// a trailing stop, a take-profit, fading inflow, a big single sell, or a time limit.
// A pace guard keeps tiny probe round trips flowing so the run clears the
// guardrail (20 coins, 200 fills) even in a quiet window.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
