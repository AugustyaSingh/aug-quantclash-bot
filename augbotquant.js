"use strict";
const { HFTSiegeClient } = require("./sdk/js/hft-siege-client");
const WS_URL = "ws://10.220.147.182:8081/ws";
const USERNAME = "augustya";
const PASSWORD = "aug_1234hhh";
const RING_SIZE = 100;
const OFI_WINDOW = 20;
const OFI_THRESHOLD = 0.30;
const MAX_EXPOSURE_CENTS = 2_000_000;
const ORDER_STRONG_CENTS = 600_000;
const ORDER_MED_CENTS = 300_000;
const ORDER_NEWS_CENTS = 700_000;
const ORDER_NEWS_XL_CENTS = 1_400_000;
const WARMUP_TICKS = OFI_WINDOW + 5;
const COOLDOWN_MS = 250;
const ORDER_TTL_MS = 800;
const SWEEP_INTERVAL_MS = 200;
const TWAP_START_SECS = 120;
const TWAP_END_SECS = 10;
const TWAP_INTERVAL_MS = 3_000;
const NEWS_MIN_SCORE = 0.20;
const CANCEL_BUCKET_RATE = 45;
const CANCEL_BUCKET_MAX = 45;
const PASSIVE_OFFSET_CENTS = 1;
const cancelBucket = {
  tokens: CANCEL_BUCKET_MAX,
  lastRefill: Date.now(),
  consume() {
    const now = Date.now();
    const dt = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      CANCEL_BUCKET_MAX,
      this.tokens + dt * CANCEL_BUCKET_RATE
    );
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  },
};
class RingBuffer {
  constructor(size) {
    this.buf = new Float64Array(size);
    this.size = size;
    this.head = 0;
    this.count = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  last() {
    if (this.count === 0) return NaN;
    const idx = (this.head - 1 + this.size) % this.size;
    return this.buf[idx];
  }
  oldest() {
    if (this.count === 0) return NaN;
    if (this.count < this.size) return this.buf[0];
    return this.buf[this.head];
  }
  at(i) {
    if (i < 0 || i >= this.count) return NaN;
    const startOffset = this.count < this.size ? 0 : this.head;
    return this.buf[(startOffset + i) % this.size];
  }
  isFull() { return this.count === this.size; }
}
class TickerState {
  constructor(ticker) {
    this.ticker = ticker;
    this.prices = new RingBuffer(RING_SIZE);
    this.ofiDeltas = new RingBuffer(OFI_WINDOW);
    this.bidVol = new RingBuffer(OFI_WINDOW);
    this.askVol = new RingBuffer(OFI_WINDOW);
    this.microPrice = 0;
    this.ofiRatio = 0;
    this.prevPrice = 0;
    this.tickCount = 0;
    this.lastOrderAt = 0;
  }
}
const ledger = {
  availableCash: 0,
  sequesteredCash: 0,
  confirmedPos: new Map(),
  openOrders: new Map(),
  pendingQueue: new Map(),
  sequester(ticker, side, priceCents, qty) {
    const cost = priceCents * qty;
    if (side === "BUY") {
      this.availableCash -= cost;
      this.sequesteredCash += cost;
    }
    const key = `${ticker}:${side}`;
    if (!this.pendingQueue.has(key)) this.pendingQueue.set(key, []);
    this.pendingQueue.get(key).push({ ticker, side, priceCents, qty, sentAt: Date.now() });
  },
  confirmPending(serverOrderId, ticker, side) {
    const key = `${ticker}:${side}`;
    const queue = this.pendingQueue.get(key);
    if (!queue || queue.length === 0) return null;
    const entry = queue.shift();
    this.openOrders.set(serverOrderId, entry);
    return entry;
  },
  rejectPending(ticker, side) {
    const key = `${ticker}:${side}`;
    const queue = this.pendingQueue.get(key);
    if (!queue || queue.length === 0) return;
    const entry = queue.shift();
    if (entry.side === "BUY") {
      const cost = entry.priceCents * entry.qty;
      this.availableCash += cost;
      this.sequesteredCash = Math.max(0, this.sequesteredCash - cost);
    }
  },
  release(serverOrderId) {
    const o = this.openOrders.get(serverOrderId);
    if (!o) return;
    if (o.side === "BUY") {
      const cost = o.priceCents * o.qty;
      this.availableCash += cost;
      this.sequesteredCash = Math.max(0, this.sequesteredCash - cost);
    }
    this.openOrders.delete(serverOrderId);
  },
  reconcile(serverCashCents, serverPos) {
    const localTotal = this.availableCash + this.sequesteredCash;
    const serverTotal = serverCashCents;
    if (Math.abs(serverTotal - localTotal) > 500) {
      const drift = serverTotal - localTotal;
      this.availableCash += drift;
      if (drift !== 0) {
        console.warn(`⚠️  Ledger drift corrected: ${drift > 0 ? "+" : ""}${(drift / 100).toFixed(2)}`);
      }
    }
    for (const [ticker, qty] of Object.entries(serverPos ?? {})) {
      if (typeof qty === "number") {
        this.confirmedPos.set(ticker, qty);
      }
    }
  },
  exposureCents(ticker, currentPriceCents) {
    return (this.confirmedPos.get(ticker) ?? 0) * currentPriceCents;
  },
};
function trackOrder(_id, _ticker) { }
function untrackOrder(_id, _ticker) { }
let _pendingLabel = 0;
function nextLabel() {
  return ++_pendingLabel;
}
function updateOFI(state, newPriceCents) {
  const prev = state.prevPrice;
  if (prev === 0) return;
  const delta = newPriceCents - prev;
  state.bidVol.push(delta > 0 ? delta : 0);
  state.askVol.push(delta < 0 ? -delta : 0);
  state.ofiDeltas.push(delta);
}
function computeMicroPrice(state, midPriceCents) {
  let totalBid = 0;
  let totalAsk = 0;
  const n = state.bidVol.count;
  for (let i = 0; i < n; i++) {
    totalBid += state.bidVol.at(i);
    totalAsk += state.askVol.at(i);
  }
  const total = totalBid + totalAsk;
  if (total === 0) return midPriceCents;
  const bidPrice = midPriceCents - PASSIVE_OFFSET_CENTS;
  const askPrice = midPriceCents + PASSIVE_OFFSET_CENTS;
  return Math.round((totalBid * askPrice + totalAsk * bidPrice) / total);
}
function computeOFIRatio(state) {
  let netFlow = 0;
  let totalFlow = 0;
  const n = state.ofiDeltas.count;
  for (let i = 0; i < n; i++) {
    const d = state.ofiDeltas.at(i);
    netFlow += d;
    totalFlow += Math.abs(d);
  }
  if (totalFlow === 0) return 0;
  return netFlow / totalFlow;
}
const client = new HFTSiegeClient({
  url: WS_URL,
  username: USERNAME,
  password: PASSWORD,
  reconnect: true,
});

// 🚨 THE MONKEY PATCH: Intercept and fix SDK bugs from our side 🚨
if (typeof client._dispatch === 'function') {
  const originalDispatch = client._dispatch.bind(client);

  client._dispatch = function (msg) {
    try {
      let parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;

      // If it's the leaderboard and payload is an Array (the bug causing the crash)
      if (parsed && parsed.type === "leaderboard" && Array.isArray(parsed.payload)) {

        // Translate PascalCase server keys to snake_case so the SDK finds them
        const fixedEntries = parsed.payload.map(e => ({
          participant_id: e.ParticipantID,
          net_worth: e.NetWorth,
          cash: e.Cash
        }));

        // Re-shape the payload into the { entries: [] } format the SDK is looking for
        parsed.payload = { entries: fixedEntries };

        // Hand the fixed data back to the original SDK function
        return originalDispatch(typeof msg === 'string' ? JSON.stringify(parsed) : parsed);
      }
    } catch (e) {
      console.warn("⚠️  Monkey patch dispatch error:", e.message);
    }

    // For all other normal messages (prices, trades), pass them through untouched
    return originalDispatch(msg);
  };
}
// ═══════════════════════════════════════════════════════════════════
const tickerStates = new Map();
let roundActive = false;
let remainingSecs = 600;
let myRank = "?";
let twapTimerId = null;
let sweepTimerId = null;
let frozenUntil = 0;
client.on("connected", () => {
  console.log(`\n✅ Connected as "${USERNAME}" — OFI engine warming up...\n`);
  if (sweepTimerId) clearInterval(sweepTimerId);
  sweepTimerId = setInterval(sweepStaleLimitOrders, SWEEP_INTERVAL_MS);
});
client.on("disconnected", ({ code }) => {
  console.warn(`🔌 Disconnected (${code}). Reconnecting...`);
  roundActive = false;
  frozenUntil = 0;
  clearInterval(sweepTimerId);
  clearInterval(twapTimerId);
  twapTimerId = null;
});
client.on("round_status", ({ state, remainingSeconds }) => {
  const wasActive = roundActive;
  roundActive = state === "Active";
  if (typeof remainingSeconds === "number" && isFinite(remainingSeconds)) {
    remainingSecs = remainingSeconds;
  }
  if (roundActive && !wasActive) {
    console.log(`\n🚀 ROUND ACTIVE! ${remainingSecs}s remaining — SIEGE ENGINE LIVE!\n`);
  } else if (!roundActive && wasActive) {
    console.log(`\n⏸️  Round is now: ${state}`);
    clearInterval(twapTimerId);
    twapTimerId = null;
  }
  if (roundActive && remainingSecs <= TWAP_START_SECS && twapTimerId === null) {
    console.log(`\n⏳ T-${remainingSecs}s — TWAP LIQUIDATION ENGAGED`);
    startTwapLiquidation();
  }
});
client.on("wallet_update", ({ cash: c, positions: pos, netWorthDollars }) => {
  if (typeof c === "number" && isFinite(c)) {
    ledger.reconcile(c, pos);
  }
  const worthStr = typeof netWorthDollars === "number"
    ? `$${netWorthDollars.toFixed(2)}` : "N/A";
  const avail = (ledger.availableCash / 100).toFixed(2);
  const seq = (ledger.sequesteredCash / 100).toFixed(2);
  console.log(`💰 Available: $${avail} | Sequestered: $${seq} | Net Worth: ${worthStr} | Rank: ${myRank}`);
});
client.on("price_update", ({ ticker, price }) => {
  if (!ticker || !price || price <= 0 || !Number.isFinite(price)) return;
  if (!tickerStates.has(ticker)) {
    tickerStates.set(ticker, new TickerState(ticker));
  }
  const state = tickerStates.get(ticker);
  updateOFI(state, price);
  state.prices.push(price);
  state.prevPrice = price;
  state.tickCount++;
  if (state.ofiDeltas.count >= OFI_WINDOW) {
    state.microPrice = computeMicroPrice(state, price);
    state.ofiRatio = computeOFIRatio(state);
  }
  if (!roundActive) return;
  if (state.tickCount < WARMUP_TICKS) return;
  if (remainingSecs <= TWAP_START_SECS) return;
  const now = Date.now();
  if (now - state.lastOrderAt < COOLDOWN_MS) return;
  evaluateOFISignal(ticker, price, state, now);
});
function evaluateOFISignal(ticker, priceCents, state, now) {
  const ofi = state.ofiRatio;
  const micro = state.microPrice;
  const absOFI = Math.abs(ofi);
  if (absOFI < OFI_THRESHOLD) return;
  const isStrong = absOFI >= 0.55;
  const confirmedShares = ledger.confirmedPos.get(ticker) ?? 0;
  const pendingBuyQueue = ledger.pendingQueue.get(`${ticker}:BUY`) ?? [];
  const pendingSellQueue = ledger.pendingQueue.get(`${ticker}:SELL`) ?? [];
  const pendingBuyQty = pendingBuyQueue.reduce((s, o) => s + o.qty, 0);
  const pendingSellQty = pendingSellQueue.reduce((s, o) => s + o.qty, 0);
  const effectiveLong = Math.max(0, confirmedShares - pendingSellQty);
  const effectiveBuyExposure = (confirmedShares + pendingBuyQty) * priceCents;
  if (ofi > 0) {
    const headroomCents = MAX_EXPOSURE_CENTS - effectiveBuyExposure;
    if (headroomCents <= 0) return;
    const budgetCents = isStrong ? ORDER_STRONG_CENTS : ORDER_MED_CENTS;
    const spendCents = Math.min(budgetCents, headroomCents, ledger.availableCash);
    const qty = Math.floor(spendCents / priceCents);
    if (qty <= 0) return;
    const limitPrice = Math.max(micro - PASSIVE_OFFSET_CENTS, priceCents - 2);
    submitOrder(ticker, "BUY", limitPrice, qty, state, now);
  } else {
    if (effectiveLong <= 0) return;
    const budgetCents = isStrong ? ORDER_STRONG_CENTS : ORDER_MED_CENTS;
    const qty = Math.min(effectiveLong, Math.floor(budgetCents / priceCents));
    if (qty <= 0) return;
    const limitPrice = micro + PASSIVE_OFFSET_CENTS;
    submitOrder(ticker, "SELL", limitPrice, qty, state, now);
  }
}
function submitOrder(ticker, side, priceCents, qty, state, now) {
  if (side === "BUY" && ledger.availableCash < priceCents * qty) return;
  const label = nextLabel();
  ledger.sequester(ticker, side, priceCents, qty);
  const tag = side === "BUY" ? "📗 BUY " : "📕 SELL";
  console.log(
    `${tag}  ${ticker} x${qty} @ $${(priceCents / 100).toFixed(2)}` +
    `  OFI=${(state?.ofiRatio ?? 0).toFixed(2)}` +
    `  μP=$${((state?.microPrice ?? priceCents) / 100).toFixed(2)}` +
    `  avail=$${(ledger.availableCash / 100).toFixed(0)}` +
    `  pending#${label}`
  );
  client.submitLimitOrder(ticker, side, priceCents, qty);
  if (state) state.lastOrderAt = now ?? Date.now();
}
function sweepStaleLimitOrders() {
  if (frozenUntil > Date.now()) return;
  const now = Date.now();
  for (const [orderId, order] of ledger.openOrders.entries()) {
    if (now - order.sentAt < ORDER_TTL_MS) continue;
    if (!cancelBucket.consume()) break;
    console.log(
      `🗑  Cancel stale order ${orderId}` +
      ` ${order.side} ${order.ticker} x${order.qty}` +
      ` (age ${now - order.sentAt}ms)`
    );
    client.cancelOrder(order.ticker, orderId);
    ledger.release(orderId);
    untrackOrder(orderId, order.ticker);
  }
}
client.on("news_flash", ({ headline, ticker, sentimentScore }) => {
  if (!roundActive || remainingSecs <= TWAP_START_SECS) return;
  if (sentimentScore == null || !Number.isFinite(sentimentScore)) return;
  const absScore = Math.abs(sentimentScore);
  if (absScore < NEWS_MIN_SCORE) return;
  const scoreStr = sentimentScore > 0
    ? `+${sentimentScore.toFixed(2)}` : sentimentScore.toFixed(2);
  console.log(`\n📰 NEWS [score=${scoreStr}] "${headline ?? "(no headline)"}"`);
  const targets = ticker ? [ticker] : [...tickerStates.keys()];
  for (const t of targets) {
    const state = tickerStates.get(t);
    if (!state || state.prices.count === 0) continue;
    const rawPrice = state.prices.last();
    const latestPrice = (typeof rawPrice === "number" && isFinite(rawPrice) && rawPrice > 0)
      ? rawPrice : 0;
    if (latestPrice <= 0) continue;
    const micro = state.microPrice || latestPrice;
    const confirmedQty = ledger.confirmedPos.get(t) ?? 0;
    const budget = absScore > 0.6 ? ORDER_NEWS_XL_CENTS : ORDER_NEWS_CENTS;
    const pendingBuys = (ledger.pendingQueue.get(`${t}:BUY`) ?? []).reduce((s, o) => s + o.qty, 0);
    const pendingSells = (ledger.pendingQueue.get(`${t}:SELL`) ?? []).reduce((s, o) => s + o.qty, 0);
    const effectiveLong = Math.max(0, confirmedQty - pendingSells);
    const effectiveBuyExposure = (confirmedQty + pendingBuys) * latestPrice;
    if (sentimentScore > 0) {
      const headroom = MAX_EXPOSURE_CENTS - effectiveBuyExposure;
      if (headroom <= 0) continue;
      const spendCents = Math.min(budget, headroom, ledger.availableCash);
      const qty = Math.floor(spendCents / latestPrice);
      if (qty <= 0) continue;
      const limitPrice = Math.max(micro, latestPrice);
      console.log(`   🚀 NEWS BUY  ${t} x${qty} @ $${(limitPrice / 100).toFixed(2)} (limit)`);
      submitOrder(t, "BUY", limitPrice, qty, state, Date.now());
    } else {
      if (effectiveLong <= 0) continue;
      const qty = Math.min(effectiveLong, Math.floor(budget / latestPrice));
      if (qty <= 0) continue;
      const limitPrice = Math.max(micro, latestPrice);
      console.log(`   ⚠️  NEWS SELL ${t} x${qty} @ $${(limitPrice / 100).toFixed(2)} (limit)`);
      submitOrder(t, "SELL", limitPrice, qty, state, Date.now());
    }
  }
  console.log();
});
function startTwapLiquidation() {
  if (twapTimerId !== null) return;
  twapTimerId = setInterval(() => {
    if (!roundActive || remainingSecs <= 0) {
      clearInterval(twapTimerId);
      twapTimerId = null;
      return;
    }
    const timeLeft = Math.max(remainingSecs - TWAP_END_SECS, 1);
    const tranches = Math.max(1, Math.floor(timeLeft * 1000 / TWAP_INTERVAL_MS));
    let totalLiquidated = 0;
    for (const [ticker, qty] of ledger.confirmedPos.entries()) {
      if (qty <= 0) continue;
      const state = tickerStates.get(ticker);
      const rawPrice = state?.prices.last();
      const latestPrice = (typeof rawPrice === "number" && isFinite(rawPrice) && rawPrice > 0)
        ? rawPrice : 0;
      if (latestPrice <= 0) continue;
      const pendingSells = (ledger.pendingQueue.get(`${ticker}:SELL`) ?? [])
        .reduce((s, o) => s + o.qty, 0);
      const availableQty = Math.max(0, qty - pendingSells);
      if (availableQty <= 0) continue;
      const trancheQty = Math.max(1, Math.ceil(availableQty / tranches));
      const sellQty = Math.min(availableQty, trancheQty);
      const micro = state?.microPrice || latestPrice;
      const limitPrice = Math.max(micro - PASSIVE_OFFSET_CENTS, latestPrice - 5);
      console.log(
        `⏳ TWAP SELL ${ticker} x${sellQty}/${qty}` +
        ` @ $${(limitPrice / 100).toFixed(2)}` +
        ` (T-${remainingSecs}s, ${tranches} tranches left)`
      );
      submitOrder(ticker, "SELL", limitPrice, sellQty, state, Date.now());
      totalLiquidated += sellQty;
    }
    if (totalLiquidated === 0) {
      console.log("⏳ TWAP: No open positions — liquidation complete.");
      clearInterval(twapTimerId);
      twapTimerId = null;
    }
  }, TWAP_INTERVAL_MS);
}
client.on("order_response", ({ orderId: serverOrderId, success, message, trades }) => {
  if (!success) {
    let oldestTime = Infinity;
    let oldestKey = null;
    for (const [key, queue] of ledger.pendingQueue.entries()) {
      if (queue.length > 0 && queue[0].sentAt < oldestTime) {
        oldestTime = queue[0].sentAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const [ticker, side] = oldestKey.split(":");
      ledger.rejectPending(ticker, side);
      console.warn(`⚠️  Order rejected (server id=${serverOrderId}): ${message}`);
    } else {
      console.warn(`⚠️  Order ${serverOrderId} rejected but no pending entry found: ${message}`);
    }
    return;
  }
  let oldestTime2 = Infinity;
  let oldestKey2 = null;
  for (const [key, queue] of ledger.pendingQueue.entries()) {
    if (queue.length > 0 && queue[0].sentAt < oldestTime2) {
      oldestTime2 = queue[0].sentAt;
      oldestKey2 = key;
    }
  }
  if (oldestKey2) {
    const [ticker, side] = oldestKey2.split(":");
    const entry = ledger.confirmPending(serverOrderId, ticker, side);
    if (entry) {
      trackOrder(serverOrderId, ticker);
      console.log(`✅ Order confirmed: server id=${serverOrderId}  ${side} ${ticker} x${entry.qty}`);
      if (Array.isArray(trades) && trades.length > 0) {
        for (const t of trades) {
          const filledQty = t.quantity ?? t.qty ?? 0;
          if (filledQty > 0) {
            const prev = ledger.confirmedPos.get(ticker) ?? 0;
            if (side === "BUY") {
              ledger.confirmedPos.set(ticker, prev + filledQty);
            } else {
              ledger.confirmedPos.set(ticker, Math.max(0, prev - filledQty));
            }
          }
        }
        const totalFilled = trades.reduce((s, t) => s + (t.quantity ?? t.qty ?? 0), 0);
        const entry2 = ledger.openOrders.get(serverOrderId);
        if (entry2 && totalFilled >= entry2.qty) {
          ledger.release(serverOrderId);
          untrackOrder(serverOrderId, ticker);
        }
      }
    }
  } else {
    console.warn(`⚠️  order_response success but no pending entry found for server id=${serverOrderId}`);
  }
});
client.on("trade", ({ ticker, quantity, priceDollars, buyerId, sellerId, tradeId }) => {
  const isBuyer = buyerId === USERNAME;
  const isSeller = sellerId === USERNAME;
  if (!isBuyer && !isSeller) return;
  const role = isBuyer ? "BOUGHT" : "SOLD";
  const priceStr = typeof priceDollars === "number"
    ? `$${priceDollars.toFixed(2)}` : "?";
  console.log(`🤝 ${role} ${ticker} x${quantity} @ ${priceStr}  [tradeId=${tradeId ?? "?"}]`);
  const prev = ledger.confirmedPos.get(ticker) ?? 0;
  if (isBuyer) {
    ledger.confirmedPos.set(ticker, prev + quantity);
    releaseOldestOpenOrder(ticker, "BUY", quantity);
  } else {
    ledger.confirmedPos.set(ticker, Math.max(0, prev - quantity));
    releaseOldestOpenOrder(ticker, "SELL", quantity);
  }
});
function releaseOldestOpenOrder(ticker, side, qty) {
  let oldestId = null;
  let oldestTime = Infinity;
  for (const [id, o] of ledger.openOrders.entries()) {
    if (o.ticker === ticker && o.side === side && o.sentAt < oldestTime) {
      oldestId = id;
      oldestTime = o.sentAt;
    }
  }
  if (oldestId === null) return;
  const o = ledger.openOrders.get(oldestId);
  if (o.qty <= qty) {
    ledger.release(oldestId);
    untrackOrder(oldestId, ticker);
  } else {
    o.qty -= qty;
    if (o.side === "BUY") {
      const released = o.priceCents * qty;
      ledger.sequesteredCash = Math.max(0, ledger.sequesteredCash - released);
    }
  }
}
client.on("fraud_alert", (payload) => {
  frozenUntil = Date.now() + 60_000;
  console.error(`\n🚨 FRAUD ALERT — wallet frozen for 60s! ${JSON.stringify(payload)}`);
  console.error(`   Cancel sweeper paused until freeze expires.\n`);
});
client.on("leaderboard", (entries) => {
  if (!Array.isArray(entries)) return;
  const me = entries.find(e => e.participantId === USERNAME);
  if (me) {
    myRank = `#${me.rank}`;
    const total = entries.length;
    const emoji = me.rank === 1 ? "🥇" : me.rank === 2 ? "🥈" : me.rank === 3 ? "🥉" : "📊";
    const worth = typeof me.netWorthDollars === "number"
      ? `$${me.netWorthDollars.toFixed(2)}` : "N/A";
    console.log(`${emoji} Rank: ${myRank}/${total} | Net Worth: ${worth}`);
  }
});
client.on("round_end", (payload) => {
  roundActive = false;
  clearInterval(twapTimerId);
  twapTimerId = null;
  console.log(`\n🏁 ═══════════════════════════════════════`);
  console.log(`   ROUND OVER — FINAL LEADERBOARD`);
  console.log(`   Winner: ${payload?.winner ?? "?"}`);
  console.log(`═════════════════════════════════════════`);
  (payload?.leaderboard ?? []).slice(0, 10).forEach((e, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    const isMe = e.participant_id === USERNAME;
    const marker = isMe ? "  ⬅️  YOU" : "";
    const worth = typeof e.net_worth === "number"
      ? `$${(e.net_worth / 100).toFixed(2)}`
      : "N/A";
    console.log(`  ${medal}  ${e.participant_id ?? "?"}: ${worth}${marker}`);
  });
  console.log(`\n`);
});
client.on("error", (message) => {
  console.error(`❌ Server error: ${message}`);
});
console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║         SIEGE ENGINE v2  —  HFT Siege               ║`);
console.log(`╠══════════════════════════════════════════════════════╣`);
console.log(`║  Alpha:     Order Flow Imbalance + Micro-Price       ║`);
console.log(`║  Execution: Passive limits, TTL sweep, token-bucket  ║`);
console.log(`║  Risk:      Authoritative ledger, $20k/ticker cap    ║`);
console.log(`║  Endgame:   TWAP liquidation T-120s → T-10s         ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`  Team: ${USERNAME}`);
console.log(`  URL:  ${WS_URL}`);
console.log(`  Max exposure: $${(MAX_EXPOSURE_CENTS / 100).toLocaleString()} / ticker`);
console.log(`  Cancel rate:  ${CANCEL_BUCKET_RATE}/sec (anti-spoof safe)`);
console.log(`\n`);
client.connect().catch(err => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});