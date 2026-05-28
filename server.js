/*
  server.js — Express HTTP server. Entry point for everything.

  All business logic lives in rules.js and store.js — this file's only job
  is to wire HTTP routes to that logic, handle validation, and manage the
  startup sequence. Kept intentionally thin so the rules stay readable.
*/

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const { store, getOrCreateProfile, updatePayerProfile, recordPayerHistory, recordBaseline } = require('./store');
const { evaluate } = require('./rules');
const { buildSimulationTransactions } = require('./simulation');
const { initDB, saveTransaction, loadAll } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ── processTransaction ────────────────────────────────────────────────────────
//
// Single function shared by the HTTP route AND the simulation loop.
// Centralising this means both paths go through identical validation,
// evaluation, and recording — no risk of the simulation behaving differently
// from real submissions.
//
// Order matters here:
//   1. Build tx object
//   2. Read profile (BEFORE updating it)
//   3. Run rules against that profile
//   4. Push to in-memory store
//   5. Update profile, tier, baseline (AFTER rules ran)
//   6. Persist to disk (non-blocking, doesn't delay the response)

function processTransaction(data, isSimulated = false) {
  const { payer_id, payee_id, amount, timestamp, location = '', device_id } = data;

  const tx = {
    id:        uuidv4(),
    payer_id:  String(payer_id).trim(),
    payee_id:  String(payee_id).trim(),
    amount:    Number(amount),
    // Two timestamp fields for a reason:
    //   timestamp  — when the transaction actually happened (can be in the past
    //                for simulated/backdated transactions — the 2 AM demo uses this)
    //   receivedAt — when our server saw it (always real wall-clock time)
    // Rules use `timestamp` so backdated sim transactions evaluate correctly.
    timestamp:  (timestamp && timestamp !== '') ? new Date(timestamp).toISOString() : new Date().toISOString(),
    location:   String(location).trim(),
    device_id:  String(device_id).trim(),
    receivedAt: new Date().toISOString(),
    simulated:  isSimulated,
  };

  // Snapshot the profile BEFORE this transaction is recorded into it.
  // See store.js for the full explanation of why order matters.
  const profile = store.payerProfiles.has(tx.payer_id)
    ? store.payerProfiles.get(tx.payer_id)
    : null;

  const assessment = evaluate(tx, profile);
  const record = { ...tx, ...assessment };

  store.allTransactions.push(record);
  if (assessment.flagged) {
    store.flaggedTransactions.push(record);
    // Bucket by the transaction's hour (not server's hour) so the heatmap
    // correctly reflects when fraud happened, not when we processed it.
    store.hourlyFlagCounts[new Date(tx.timestamp).getHours()]++;
  }

  // Update all history structures after rules have run.
  updatePayerProfile(tx);
  recordPayerHistory(tx.payer_id, tx.payee_id);
  recordBaseline(tx.payer_id, tx.device_id, tx.location);

  // Fire-and-forget disk write. The HTTP response goes back immediately —
  // the client doesn't wait for disk I/O. If the write fails, it's logged
  // but doesn't break the transaction flow.
  saveTransaction(record);

  return record;
}


// ── POST /api/transaction ─────────────────────────────────────────────────────

app.post('/api/transaction', (req, res) => {
  const { payer_id, payee_id, amount, device_id } = req.body;

  if (!payer_id || !payee_id || !amount || !device_id) {
    return res.status(400).json({ error: 'Required: payer_id, payee_id, amount, device_id' });
  }
  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const record = processTransaction(req.body, false);
  return res.status(201).json(record);
});


// ── GET /api/status ───────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const flagged = store.flaggedTransactions;
  const avgScore = flagged.length
    ? Math.round(flagged.reduce((s, t) => s + t.riskScore, 0) / flagged.length)
    : 0;

  res.json({
    totalTransactions: store.allTransactions.length,
    flaggedCount:      flagged.length,
    avgRiskScore:      avgScore,
    // The full 24-element array goes to the frontend — Chart.js uses it directly.
    hourlyFlagCounts:  store.hourlyFlagCounts,
  });
});


// ── GET /api/flagged ──────────────────────────────────────────────────────────

app.get('/api/flagged', (_req, res) => {
  // Reverse so newest appears first in the dashboard table.
  // Sliced to 100 — showing more than that in a browser table is unusable anyway.
  const items = [...store.flaggedTransactions].reverse().slice(0, 100);
  res.json({ items, total: store.flaggedTransactions.length });
});


// ── POST /api/simulate ────────────────────────────────────────────────────────

let simulationRunning = false;

app.post('/api/simulate', (req, res) => {
  if (simulationRunning) {
    return res.status(409).json({ error: 'Simulation already in progress' });
  }

  simulationRunning = true;
  const txList = buildSimulationTransactions();

  // Respond immediately — the client starts its progress bar.
  // Transactions fire asynchronously after the response is sent.
  res.json({ message: 'Simulation started', total: txList.length, intervalMs: 2000 });

  // Why setTimeout instead of a synchronous loop?
  // Node.js is single-threaded. A tight loop processing 20 transactions would
  // block the event loop for the entire duration — no other requests could be
  // handled, and the dashboard polls would time out. setTimeout schedules each
  // transaction 2 seconds apart without ever blocking the thread.
  txList.forEach((data, i) => {
    setTimeout(() => {
      try {
        processTransaction(data, true);
      } catch (err) {
        console.error('Simulation error at tx', i, err.message);
      }
      if (i === txList.length - 1) simulationRunning = false;
    }, i * 2000);
  });
});


// ── GET /api/db ───────────────────────────────────────────────────────────────

app.get('/api/db', (_req, res) => {
  res.json({
    total:   store.allTransactions.length,
    flagged: store.flaggedTransactions.length,
    records: store.allTransactions,
  });
});


// ── GET /export — streamed CSV ────────────────────────────────────────────────
//
// Why streamed? If we built the entire CSV as a string first, we'd allocate
// memory proportional to the number of flagged transactions. With 100k rows
// that's a multi-MB string sitting in RAM doing nothing while we write it.
//
// res.write() sends each row to the client as soon as it's ready.
// Memory stays flat at roughly one row at a time regardless of dataset size.
// The browser starts downloading immediately rather than waiting for the full file.

app.get('/export', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="flagged_transactions.csv"');

  // Wrap any cell that contains commas, quotes, or newlines in double quotes.
  // This is the minimal CSV escaping that Excel and Google Sheets both handle.
  const cell = (v) => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (cols) => cols.map(cell).join(',') + '\n';

  res.write(row([
    'ID', 'Payer ID', 'Payee ID', 'Amount (₹)', 'Timestamp',
    'Location', 'Device ID', 'Risk Score', 'Risk Level',
    'Triggered Rules', 'Reasons', 'Simulated',
  ]));

  for (const tx of store.flaggedTransactions) {
    res.write(row([
      tx.id, tx.payer_id, tx.payee_id, tx.amount, tx.timestamp,
      tx.location, tx.device_id, tx.riskScore, tx.riskLevel,
      tx.triggeredRules.map(r => r.code).join(' | '),
      tx.triggeredRules.map(r => r.reason).join(' | '),
      tx.simulated ? 'yes' : 'no',
    ]));
  }

  res.end();
});


// ── Startup sequence ──────────────────────────────────────────────────────────
//
// The server doesn't listen until the DB is loaded and memory is rebuilt.
// This prevents a race condition where a request arrives before historical
// payer profiles are restored — which would cause velocity rules to behave
// as if everyone is a brand-new payer.
//
// Wrapped in an IIFE (immediately invoked function) because top-level await
// isn't available in Node 18 CommonJS mode.

(async () => {
  await initDB();

  const saved = await loadAll();
  for (const r of saved) {
    const tx = {
      payer_id:  r.payer_id,
      payee_id:  r.payee_id,
      amount:    r.amount,
      timestamp: r.timestamp,
      location:  r.location,
      device_id: r.device_id,
    };
    const record = {
      ...r,
      // DB stores snake_case; in-memory uses camelCase. Normalise both so
      // old records and new records both work after a restart.
      riskScore:      r.risk_score      ?? r.riskScore,
      riskLevel:      r.risk_level      ?? r.riskLevel,
      triggeredRules: r.triggered_rules ?? r.triggeredRules ?? [],
    };
    store.allTransactions.push(record);
    if (record.flagged) {
      store.flaggedTransactions.push(record);
      store.hourlyFlagCounts[new Date(r.timestamp).getHours()]++;
    }
    updatePayerProfile(tx);
    recordPayerHistory(r.payer_id, r.payee_id);
    recordBaseline(r.payer_id, r.device_id, r.location);
  }

  console.log(`[Boot] Rehydrated ${saved.length} transaction(s) from fraud.json`);

  // Wildcard route registered last so it doesn't swallow API routes.
  app.get('*', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  );

  app.listen(PORT, () => {
    console.log(`\n  UPI Fraud Detector → http://localhost:${PORT}`);
    console.log(`  CSV Export         → http://localhost:${PORT}/export\n`);
  });
})();
