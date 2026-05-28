/**
 * db.js — Persistent JSON file store via lowdb.
 *
 * lowdb is pure-JavaScript (no native build needed). It writes a human-readable
 * fraud.json file next to server.js. In-memory store stays the source of truth
 * for fast velocity reads; this layer adds durability across restarts.
 */

const { Low, JSONFile } = require('lowdb');
const path = require('path');

const adapter = new JSONFile(path.join(__dirname, 'fraud.json'));
const db = new Low(adapter);

/** Call once at startup before accepting requests. */
async function initDB() {
  await db.read();
  db.data ??= { transactions: [] };
  await db.write();
  console.log(`[DB] fraud.json ready — ${db.data.transactions.length} existing record(s)`);
}

/** Persist a fully-evaluated transaction record. Non-blocking — errors are logged, not thrown. */
async function saveTransaction(record) {
  try {
    await db.read();
    db.data.transactions.push({
      id:              record.id,
      payer_id:        record.payer_id,
      payee_id:        record.payee_id,
      amount:          record.amount,
      timestamp:       record.timestamp,
      location:        record.location || '',
      device_id:       record.device_id,
      risk_score:      record.riskScore,
      risk_level:      record.riskLevel,
      flagged:         record.flagged,
      triggered_rules: record.triggeredRules || [],
      simulated:       record.simulated || false,
      received_at:     record.receivedAt,
    });
    await db.write();
  } catch (err) {
    console.error('[DB] write error:', err.message);
  }
}

/** Return all stored transaction records (called once on startup to rebuild memory). */
async function loadAll() {
  await db.read();
  return db.data.transactions ?? [];
}

module.exports = { initDB, saveTransaction, loadAll };
