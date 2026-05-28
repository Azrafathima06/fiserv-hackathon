# UPI Fraud Detector

A real-time UPI transaction fraud detection system built with Node.js. Transactions are evaluated instantly against a rule-based scoring engine and surfaced on a live dashboard with risk levels, reason codes, and hourly heatmaps.

---

## How It Works

Every transaction submitted — manually or via simulation — is scored from 0 to 100 across five fraud rules. Once a score hits 40 or above, the transaction is flagged. The dashboard updates every two seconds without a page refresh.

| Risk Level | Score Range | Meaning |
|---|---|---|
| LOW | 0 – 39 | Passes all checks |
| MEDIUM | 40 – 59 | One moderate signal |
| HIGH | 60 – 79 | One serious or two moderate signals |
| CRITICAL | 80 – 100 | Multiple serious signals |

---

## Fraud Rules

| Rule | Trigger | Score |
|---|---|---|
| `HIGH_AMOUNT_VELOCITY` | Two transactions of 10,000+ within 60 seconds from the same payer | +45 |
| `HIGH_VELOCITY_NEW_BENEFICIARY` | Payer exceeds tier velocity limit, paying a new recipient | +30 |
| `HIGH_VELOCITY_KNOWN_PAYEES` | Payer exceeds tier velocity limit, paying a familiar recipient | +5 |
| `FIRST_TIME_PAYEE_HIGH_AMOUNT` | First-ever payment to this payee and amount exceeds 5,000 | +40 |
| `DEVICE_CHANGE_NEW_PAYEE` | Device changed from last known device and payee is new | +35 |
| `TRUSTED_ACCOUNT_ANOMALY` | Trusted payer using an unknown device with a second deviation | +50 |
| `UNUSUAL_HOUR` | Transaction between midnight and 4 AM | +20 |

### Tiered Velocity Thresholds

The velocity rule classifies each payer into one of three tiers based on their transaction history.

| Tier | Who | Threshold (transactions / 5 min) |
|---|---|---|
| Trusted | IDs in the trusted payers list | 50 |
| Known | Any payer seen at least once before | 20 |
| Unknown | Brand-new payer, never seen before | 10 |

Trusted payers: `PAYROLL_DEPT_22`, `BUSINESS_ACC_01`

---

## Project Structure

```
fiserv-hackathon/
├── server.js        — Express server, all HTTP routes, transaction processing
├── rules.js         — Fraud rules engine, scoring logic, trusted payer config
├── store.js         — In-memory state: velocity profiles, payer history, baselines
├── db.js            — JSON file persistence via lowdb (fraud.json)
├── simulation.js    — 20 pre-built transactions with planted fraud cases
└── public/
    ├── index.html   — Main dashboard
    ├── dbview.html  — Database viewer, all transactions, filterable
    ├── app.js       — Frontend polling, chart rendering, form handling
    └── styles.css   — Dark theme
```

---

## Getting Started

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/Azrafathima06/fiserv-hackathon.git
cd fiserv-hackathon
npm install
npm start
```

Open `http://localhost:3000`

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/transaction` | Submit a transaction for evaluation |
| `GET` | `/api/status` | Dashboard stats and hourly heatmap data |
| `GET` | `/api/flagged` | Flagged transactions, newest first |
| `GET` | `/api/db` | All transactions, flagged and clean |
| `POST` | `/api/simulate` | Start the 20-transaction fraud simulation |
| `GET` | `/export` | Streamed CSV export of flagged transactions |

### Transaction Payload

```json
{
  "payer_id":  "9988776655",
  "payee_id":  "MERCHANT121",
  "amount":    9500,
  "timestamp": "2026-02-10T02:30:00",
  "location":  "Delhi",
  "device_id": "ABC123"
}
```

`timestamp` is optional. Omit it and the server uses current time. Set it to a 2 AM value to trigger the unusual-hour rule in demos.

---

## Dashboard

**Live Transaction Feed** — polls every 2 seconds. New flagged rows appear with a toast notification showing the risk level and triggered rules.

**Risk Heatmap** — bar chart showing fraud flags per hour of day. The 00:00–03:59 window renders in red.

**Simulate** — fires 20 pre-built transactions two seconds apart with a progress bar. Six fraud cases are planted to demonstrate every rule.

| Transaction | Fraud Case |
|---|---|
| #3 | `FIRST_TIME_PAYEE_HIGH_AMOUNT` — 15,000 to a new payee |
| #4 | `UNUSUAL_HOUR` + `FIRST_TIME_PAYEE_HIGH_AMOUNT` — 2 AM, 8,000 |
| #17 | `HIGH_VELOCITY_NEW_BENEFICIARY` — 12th transaction in 24 seconds |
| #18 | `HIGH_AMOUNT_VELOCITY` — second 10k+ within 34 seconds |
| #19 | `FIRST_TIME_PAYEE_HIGH_AMOUNT` — 18,000 to a new payee |
| #20 | `DEVICE_CHANGE_NEW_PAYEE` — device switched and new recipient |

**Database Viewer** — click View DB in the navbar to open a filterable table of every transaction (flagged and clean) with score bars and rule tags. Auto-refreshes every 3 seconds.

**CSV Export** — streams the flagged log row by row so memory stays flat regardless of dataset size.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Persistence | lowdb (fraud.json) |
| In-memory store | Native JS Map and Set |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Charts | Chart.js |
| ID generation | uuid |

No external databases, no cloud services. Runs fully offline.
