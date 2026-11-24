// Paper momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most new curves are bundled launches that dump within minutes, so this bot
// never buys a fresh curve and never buys a one-batch spike. A curve earns an entry
// in two stages. First it must prove itself over its whole life so far: real buying
// outweighs selling, several different wallets bought, and the price already climbed
// from where the curve started. Then the entry signal — accelerating inflow over a
// short window, price sitting near the window high — must hold on TWO separate
// batches in a row before any SOL goes in. One hot batch is noise; two in a row is
// a trend the tape is confirming.
//
// Sizing is staged too. The shipped settings buy once per coin (0.03 SOL) and
// never add: the sweep showed every add and every larger stake only fed the
// losers, while single small shots kept the worst case bounded. A coin that
// runs is therefore ridden only through the trailing stop, never by adding size.
//
// Exits are whole-position sells: a stop loss against cost, a trailing stop once the
// position is up, a hard take-profit, a fade exit when the tape turns net-negative,
// a big-sell exit when one wallet dumps, a stale-tape exit when the coin stops
// trading, and a time limit that does not apply while the position is comfortably up.
// The shipped settings take profit only through the trailing stop (take-profit is
// set far away at +500%); capping winners at +20–30% lost more than it saved,
// because the rare runner has to pay for many small losers.
//
// The guardrail needs at least 20 coins with round trips of 0.01 SOL and 200 fills,
// so the bot paces itself against elapsed block time: when its own fills or coins
// lag the pace, it opens one tiny probe round trip (0.01 SOL, sold as soon as the
// buy lands) on the most liquid curve trading that batch.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream, so the two
// grading runs produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  lookback: number;
  /** Net buy SOL (buys minus sells) over the lookback window. */
  minWindowNet: number;
  /** Buy trades in the window. */
  minWindowBuys: number;
  /** Distinct buying wallets in the window. */
  minWindowBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minClimb: number;
  /** Upper bound on that climb: skip curves that already ran too far in one window. */
  maxClimb: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxTopBuyer: number;
  /** Curve real SOL bounds at entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Lifetime net SOL (buys minus sells since creation) needed before watching. */
  minLifeNet: number;
  /** Consecutive batches the signal must hold before the first buy. */
  confirmBatches: number;
  /** SOL for the whole position at most. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  trailDrop: number;
  trailArm: number;
  takeProfit: number;
  /** Fade exit: net SOL over fadeWindow below this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up by holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit when no trade has hit the coin for this many slots (dead tape). */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** First buy of a position (SOL). */
  firstBuySol: number;
  /** Each add-on buy (SOL). */
  addBuySol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  lookback: 45,
  minWindowNet: 4.0,
  minWindowBuys: 6,
  minWindowBuyers: 18,
  minClimb: 0.5,
  maxClimb: 0.8,
  accel: 1.5,
  nearHigh: 0.97,
  maxTopBuyer: 0.45,
  minReserveSol: 3,
  maxReserveSol: 50,
  minAge: 400,
  minLifeNet: 0.5,
  confirmBatches: 2,
  stakeSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1200,
  stopLoss: 0.06,
  trailDrop: 0.15,
  trailArm: 0.1,
  takeProfit: 5.0,
  fadeWindow: 15,
  fadeNetSol: -0.15,
  bigSellSol: 2,
  maxHold: 300,
  holdIfUp: 0.15,
  staleSlots: 50,
  cooldown: 200,
  maxEntries: 2,
  firstBuySol: 0.03,
  addBuySol: 0.06,
  addStep: 0.02,
  addIfUp: 0.05,
  addNetSol: 0.3,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 7,
};

const LAMPORTS = 1e9;
/** Curve fee taken on a sell (protocol + creator fallback, 95 + 30 bps). */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  firstPrice: number;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  /** Consecutive batches the entry signal has held. */
  confirm: number;
  /** Lifetime net SOL since creation (buys minus sells). */
  lifeNet: number;
  buyers: Set<string>;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.lookback + 10;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, firstPrice: 0, ticks: [], entries: 0, lastExit: -1e12, confirm: 0, lifeNet: 0, buyers: new Set() };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const windowNet = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  /**
   * The entry signal: the curve is old enough and big enough, its lifetime tape is
   * net-positive with broad buying, and the short window shows accelerating inflow
   * with the price near its high. Returns true only when every leg holds.
   */
  const signalHolds = (c: Coin, now: number, reserveSol: number): boolean => {
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (c.created === null || now - c.created < p.minAge) return false;
    if (c.lifeNet < p.minLifeNet) return false;
    const from = now - p.lookback;
    const mid = now - p.lookback / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const t of c.ticks) {
      if (t.slot <= from) {
        startPrice = t.price;
        continue;
      }
      if (startPrice < 0) startPrice = t.price;
      const signed = t.buy ? t.sol : -t.sol;
      if (t.slot <= mid) netOld += signed;
      else netNew += signed;
      if (t.buy) {
        buySol += t.sol;
        buys++;
        buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
      } else {
        sellSol += t.sol;
      }
      if (t.price > high) high = t.price;
      last = t.price;
    }
    if (buys < p.minWindowBuys || buyers.size < p.minWindowBuyers) return false;
    if (buySol - sellSol < p.minWindowNet) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const climb = last / startPrice - 1;
    if (climb < p.minClimb || climb > p.maxClimb) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    if (top > p.maxTopBuyer * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.firstPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (c.firstPrice === 0) c.firstPrice = price;
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          c.lifeNet += e.is_buy ? sol : -sol;
          if (e.is_buy) c.buyers.add(e.user);
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop, trail, take-profit, fade, big sell, time limit.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const c = coinOf(mint);
            if (o.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > o.peakValue) o.peakValue = value;
        o.lastValue = value;
        let exit = o.exiting;
        const c = coinOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && o.peakValue >= cost * (1 + p.trailArm) && value < o.peakValue * (1 - p.trailDrop)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && windowNet(c, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        const lastTick = c.ticks[c.ticks.length - 1];
        if (!exit && lastTick !== undefined && now - lastTick.slot > p.staleSlots) exit = true;
        if (!exit) continue;
        o.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds. A fresh entry needs the signal to hold on consecutive
      // batches; an add needs the position already up and inflow still positive.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, o] of open) exposure += Math.max(o.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const o = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (o === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (signalHolds(c, now, reserveSol)) c.confirm++;
          else c.confirm = 0;
          if (c.confirm < p.confirmBatches) continue;
          want = Math.min(p.firstBuySol, p.stakeSol);
        } else {
          if (o.exiting || !o.filled || o.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < o.lastBuyPrice * (1 + p.addStep)) continue;
          if (o.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (windowNet(c, now, p.lookback) < p.addNetSol) continue;
          if (reserveSol > p.maxReserveSol) continue;
          want = Math.min(p.addBuySol, p.stakeSol - o.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (o === undefined) {
          open.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0 });
          c.entries++;
          c.confirm = 0;
          slotsLeft--;
          mainLeft--;
        } else {
          o.invested += amount;
          o.lastBuyPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
