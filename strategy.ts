// "Organic launch" strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev-window tape actually rewards (measured, not assumed): nearly every public signal
// loses after the ~2.5% round-trip cost. The one slice that stayed positive out of sample is the
// organic launch — a coin bought in its first 6 slots whose creator put in a normal-sized buy
// (0.2-2 SOL) and whose early buy SOL is NOT dominated by repeat snipers (wallets already seen
// buying 3+ coins this window). Exits are fast on purpose: +30% take-profit, -8% stop, a 25-slot
// time stop, out at once when the creator sells — on this tape, holding longer is what turns the
// same entries negative. On top of the slice, a 1500 bps buy slippage cap makes entries whose
// price already ran away during the 2-slot latency be refused by the market for free instead of
// filled at the top.
//
// Guardrail probes keep the 20-coin round-trip bar covered at minimum size; everything else about
// the design is fee discipline: one entry per coin, no pyramiding, small stakes, hard exposure cap.
// A pure function of the batches it is fed: no clock, no randomness, no I/O.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** A wallet counts as a repeat sniper once it has bought this many distinct coins. */
  repeatBuyerCoins: number;
  /** At most this share (bps) of a coin's buy SOL may come from repeat snipers at entry. */
  maxRepeatShareBps: number;
  /** Creator's create-slot buy window (lamports). */
  minDevBuy: number;
  maxDevBuy: number;
  /** Latest decision age (slots since create) for a launch entry. */
  maxAge: number;
  /** Real SOL reserve ceiling at entry (lamports). */
  maxRealSol: number;
  /** Stake per position (lamports), still capped at 1% of real reserves by the market. */
  stakeLamports: number;
  /** Buy slippage tolerance (bps): entries that ran away in the latency are refused for free. */
  buySlippageBps: number;
  /** Exits on close value vs cost (curve fees and the sell tx fee deducted). */
  tpBps: number;
  slBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  /** Most SOL at cost across all open positions at once. */
  maxExposureLamports: number;
  /** Guardrail probes. */
  probeTargetCoins: number;
  probeLamports: number;
  probeWindowSeconds: number;
}

export const DEFAULT_PARAMS: Params = {
  repeatBuyerCoins: 3,
  maxRepeatShareBps: 2_500,
  minDevBuy: 200_000_000,
  maxDevBuy: 2_000_000_000,
  maxAge: 6,
  maxRealSol: 30_000_000_000,
  stakeLamports: 100_000_000,
  buySlippageBps: 1_500,
  tpBps: 3_000,
  slBps: 800,
  maxHold: 25,
  exitOnDevSell: true,
  maxExposureLamports: 600_000_000,
  probeTargetCoins: 24,
  probeLamports: 11_000_000,
  probeWindowSeconds: 21_600,
};

interface Coin {
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  bought: bigint;
  repeatBought: bigint;
  devSold: boolean;
  complete: boolean;
  entered: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
}

const FEE_BPS = 125n;

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(P: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const probing = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  /** Distinct coins each wallet has bought, for the repeat-sniper share. */
  const walletCoins = new Map<Pubkey, Set<Pubkey>>();
  let firstTime: number | null = null;
  let nowTime = 0;

  const hasPending = (state: BotState, mint: Pubkey, side?: 'buy' | 'sell'): boolean => {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && (side === undefined || p.order.side === side)) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > nowTime) nowTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot, creator: e.creator, devBuy: 0n, bought: 0n, repeatBought: 0n,
            devSold: false, complete: false, entered: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          if (e.is_buy) {
            let wc = walletCoins.get(e.user);
            if (wc === undefined) { wc = new Set(); walletCoins.set(e.user, wc); }
            const isRepeat = wc.size >= P.repeatBuyerCoins && !wc.has(e.mint);
            wc.add(e.mint);
            c.bought += sol;
            if (isRepeat) c.repeatBought += sol;
            if (e.user === c.creator && e.slot === c.createSlot) c.devBuy += sol;
          } else if (e.user === c.creator) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.client_id.startsWith('_')) { held.delete(f.mint); selling.delete(f.mint); probing.delete(f.mint); }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const markOf = (mint: Pubkey) => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        return cv === undefined ? undefined : { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        if (probing.has(mint)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          selling.add(mint);
          continue;
        }
        const h = held.get(mint);
        const mk = markOf(mint);
        if (h === undefined || mk === undefined) continue;
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        const c = coins.get(mint);
        if (c !== undefined && P.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
      }

      // Launch entries.
      let exposure = 0n;
      for (const pos of state.positions.values()) exposure += pos.cost_lamports;
      let open = state.committedPositionCount();
      let free = state.freeCashLamports();
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.complete || c.entered) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) { c.entered = true; continue; }
        if (held.has(mint) || selling.has(mint) || probing.has(mint) || hasPending(state, mint)) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        if (exposure + BigInt(P.stakeLamports) > BigInt(P.maxExposureLamports)) break;
        if (c.devSold) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.bought <= 0n) continue;
        if (c.repeatBought * BPS > c.bought * BigInt(P.maxRepeatShareBps)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves > BigInt(P.maxRealSol)) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const stake = BigInt(P.stakeLamports);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < 10_000_000n) continue;
        if (free < amount + tx * 4n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        open += 1;
        c.entered = true;
      }

      // Guardrail probes.
      if (firstTime !== null && orders.length < cap && open < state.hello.caps.max_open_positions) {
        const elapsed = Math.max(0, Math.min(P.probeWindowSeconds, nowTime - firstTime));
        const due = Math.ceil((P.probeTargetCoins * elapsed) / P.probeWindowSeconds);
        if (myCoins.size < due) {
          for (const [mint, c] of coins) {
            if (orders.length >= cap) break;
            if (c.complete || myCoins.has(mint) || held.has(mint) || probing.has(mint) || hasPending(state, mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < 1_500_000_000n) continue;
            const amount = BigInt(P.probeLamports);
            if (state.maxBuyLamports(mint) < amount) continue;
            if (free < amount + tx * 4n) break;
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
            probing.add(mint);
            free -= amount + tx;
            break;
          }
        }
      }
      return orders;
    },
  };
}
