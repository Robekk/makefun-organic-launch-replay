// OrganicLaunch: a pump.fun replay bot (agent-fun/replay/v2) that buys only organic launches
// and leaves fast. The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
// The bot reads hello/batch lines on stdin and writes exactly one reply per batch; it is a
// pure function of the stream (no clock, no randomness, no I/O), so the grader's two runs of
// it produce identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
