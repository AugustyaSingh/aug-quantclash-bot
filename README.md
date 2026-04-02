# Aug-QuantClash Bot (Siege Engine v2) 🚀

A high-frequency algorithmic trading bot built for the **HFT Siege** competition. Engineered for sub-millisecond execution latency, this bot utilizes zero-allocation data structures and predictive order-flow modeling to act as a passive market maker on a WebSocket-based exchange.

## 🧠 Strategy Overview

**Alpha Model: Order Flow Imbalance (OFI) & Micro-Price**
The bot does not rely on simple momentum. It computes a signed **Order Flow Imbalance (OFI)** ratio over a sliding window of price ticks to predict aggressive buying or selling pressure. This OFI is combined with a synthetic **Volume-Weighted Micro-Price** to find the true fair value of the asset.
- **Strong OFI (> 0.55):** High-conviction entry with larger capital allocation.
- **Weak OFI:** Stays flat to avoid noise and fakeouts.

**Execution: Strict Maker Strategy**
All orders are submitted as **Passive Limit Orders** resting slightly inside the spread (1 cent below/above Micro-Price) to capture the spread premium and completely avoid crossing the book.

**Risk & Endgame Management**
- **TTL Sweeper:** Limit orders have a Time-To-Live (800ms). Stale orders are automatically swept/cancelled before faster participants can pick them off.
- **TWAP Liquidation:** Starting at `T-120 seconds` before round end, the bot hands trading over to a TWAP (Time-Weighted Average Price) engine that slowly bleeds off all active inventory using micro-price limit orders, ensuring a flat position and locked-in net worth before the clock runs out.
- **Event-Driven News:** Parses sentiment scores (`-1.0` to `+1.0`) from the server in real-time, immediately routing capital to high-conviction news events.

## ⚙️ Architecture & Performance

- **Zero-Allocation Data Structures:** Uses custom `Float64Array`-backed ring buffers to track market memory (tick windows) on the hot-path. This totally eliminates V8 Garbage Collection (GC) pauses during high-volume spikes.
- **Authoritative Local Ledger:** Because WebSocket `wallet_update` messages can lag under server strain, this bot implements an asynchronous FIFO `pendingQueue` to track sequencer cash strictly locally, preventing overdrafts and "double-sold" positions.
- **Anti-Spoofing Token Bucket:** Executes a strict cancel rate-limiter (≤45 actions/sec) to stay safely underneath the exchange's 60-second fraud penalty freeze window.

## 🛠️ Usage

### Prerequisites
- Node.js (v18+)
- WebSockets (`npm install ws`)

### Configuration
Edit the credentials at the top of `augbotquant.js` before running:
```javascript
const WS_URL   = "ws://<server_ip>:8081/ws";
const USERNAME = "augustya";
const PASSWORD = "your_password";
