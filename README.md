# Siege Engine v2 — HFT Siege Competition

This repository contains a high-performance algorithmic trading bot designed for the simulated High-Frequency Trading (HFT) Siege Competition. It operates on a Node.js WebSocket client and executes trades at the millisecond level.

## Core Strategy & Alpha Model
* **Order Flow Imbalance (OFI):** Tracks aggressive buying/selling pressure over a 20-tick rolling window to predict short-term price movements.
* **Volume-Weighted Micro-Price:** Calculates the true fair value of an asset using proxies for bid/ask volume to avoid crossing the spread.
* **Passive Execution:** Acts primarily as a liquidity provider (maker) by posting limit orders slightly inside the micro-price, reducing slippage.

## Risk Management & Compliance
* **Token-Bucket Rate Limiter:** Enforces a strict maximum of 45 order cancellations per second to comply with platform anti-spoofing rules and avoid account freezes.
* **Authoritative Local Ledger:** Sequestered cash tracking ensures no "double-spending" during high-latency network moments before the server acknowledges trades.
* **TWAP Liquidation:** A Time-Weighted Average Price liquidation engine safely offloads all inventory in the final 120 seconds of the round to secure net worth.

## How to Run
Ensure you have Node.js installed, configure your target WebSocket URL and credentials in the script, and run:
```bash
node augbotquant.js
