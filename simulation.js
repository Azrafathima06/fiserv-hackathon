/**
 * simulation.js — 20 pre-built transactions with planted fraud cases.
 *
 * Uses the new field schema: payer_id, payee_id, amount, timestamp, location, device_id
 *
 * Fraud cases:
 *   Tx  3 — FIRST_TIME_PAYEE_HIGH_AMOUNT          (user001 → MERCHANT003, ₹15,000, Mumbai)
 *   Tx  4 — UNUSUAL_HOUR + FIRST_TIME_PAYEE_HIGH  (user003, 2 AM, ₹8,000, Kolkata)
 *   Tx 17 — HIGH_VELOCITY                          (user004's 12th tx in <30 s)
 *   Tx 18 — HIGH_AMOUNT_VELOCITY                   (user001's 2nd ₹10k+ in <60 s)
 *   Tx 19 — FIRST_TIME_PAYEE_HIGH_AMOUNT           (user005 → MERCHANT001, ₹18,000)
 *   Tx 20 — DEVICE_CHANGE_NEW_PAYEE + HIGH_AMOUNT  (user005 changes device + new payee)
 */

function buildSimulationTransactions() {
  const today2AM = new Date();
  today2AM.setHours(2, 3, 0, 0); // 02:03 AM today → triggers UNUSUAL_HOUR

  return [
    // ── Normal ────────────────────────────────────────────────────────────────
    { payer_id: '9988776601', payee_id: 'MERCHANT001', amount: 500,   timestamp: null, location: 'Mumbai',    device_id: 'IPHONE12A' },
    { payer_id: '9988776602', payee_id: 'MERCHANT002', amount: 1200,  timestamp: null, location: 'Delhi',     device_id: 'SAMSUNG-B' },

    // ── FRAUD #1: First-time payee + ₹15,000 ─────────────────────────────────
    { payer_id: '9988776601', payee_id: 'MERCHANT003', amount: 15000, timestamp: null, location: 'Mumbai',    device_id: 'IPHONE12A' },

    // ── FRAUD #2: 2 AM + first-time payee + ₹8,000 ───────────────────────────
    { payer_id: '9988776603', payee_id: 'MERCHANT004', amount: 8000,  timestamp: today2AM.toISOString(), location: 'Kolkata', device_id: 'REDMI-C' },

    // ── Normal filler ─────────────────────────────────────────────────────────
    { payer_id: '9988776602', payee_id: 'MERCHANT005', amount: 2000,  timestamp: null, location: 'Delhi',     device_id: 'SAMSUNG-B' },

    // ── Velocity build-up: user004 fires 11 tx in rapid succession ────────────
    { payer_id: '9988776604', payee_id: 'PAY001', amount: 200,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY002', amount: 300,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY003', amount: 400,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY004', amount: 500,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY005', amount: 600,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY006', amount: 700,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY007', amount: 800,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY008', amount: 900,  timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY009', amount: 1000, timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY010', amount: 1100, timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },
    { payer_id: '9988776604', payee_id: 'PAY011', amount: 1200, timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },

    // ── FRAUD #3: HIGH_VELOCITY — 12th tx for user004 crosses >10 limit ───────
    { payer_id: '9988776604', payee_id: 'PAY012', amount: 1300, timestamp: null, location: 'Chennai', device_id: 'PIXEL-D' },

    // ── FRAUD #4: HIGH_AMOUNT_VELOCITY — user001's 2nd ₹10k+ within 34 s ──────
    { payer_id: '9988776601', payee_id: 'MERCHANT003', amount: 12000, timestamp: null, location: 'Mumbai', device_id: 'IPHONE12A' },

    // ── FRAUD #5: First-time payee + ₹18,000 ─────────────────────────────────
    { payer_id: '9988776605', payee_id: 'MERCHANT001', amount: 18000, timestamp: null, location: 'Hyderabad', device_id: 'ONEPLUS-E' },

    // ── FRAUD #6: Device switch + new payee (user005 was on ONEPLUS-E → VIVO-F) ─
    { payer_id: '9988776605', payee_id: 'MERCHANT009', amount: 9000, timestamp: null, location: 'Hyderabad', device_id: 'VIVO-F' },
  ];
}

module.exports = { buildSimulationTransactions };
