/*
  store.js — everything we need to remember between transactions, kept in RAM.

  Why in-memory and not the database?
  The velocity rules need to scan timestamps from the last 300 seconds on
  every single transaction. If that was a DB query, we'd be adding 5–50ms
  of latency per transaction and hammering the disk under load. A JavaScript
  Map lookup is under 1ms regardless of how many payers we're tracking.

  The tradeoff: this data is lost on server restart. That's why db.js exists —
  on boot, server.js reads fraud.json and calls the functions below to rebuild
  all these structures before accepting any requests.
*/

const store = {
  // Full transaction log — powers the /api/db endpoint and DB viewer.
  allTransactions:    [],

  // Only flagged ones — the dashboard only needs this subset, so we keep
  // it separate rather than filtering allTransactions on every poll.
  flaggedTransactions: [],

  /*
    Per-payer velocity profile. This is the main structure used by rules.

    txTimes          — every transaction timestamp in ms (for 5-min velocity)
    highValueTxTimes — only ₹10k+ timestamps (separate list so the high-amount
                       velocity rule doesn't have to scan and filter every time)
    payees           — Set of payee_ids this payer has ever paid (for first-time checks)
    devices          — ordered list of device_ids, latest last (for device change detection)
    locations        — ordered list of locations (kept for analyst context)
  */
  payerProfiles: new Map(),

  // 24-element array, one bucket per hour. Index 0 = midnight, index 23 = 11 PM.
  // The heatmap chart reads this directly — no aggregation needed at query time.
  hourlyFlagCounts: new Array(24).fill(0),

  // Every payer_id we've ever processed. Used by the velocity rule to decide
  // whether a payer is "known" (seen before) or "unknown" (brand new).
  // A Set because we only care about membership, not count or order.
  knownPayers: new Set(),

  // Maps each payer to the set of payees they've explicitly paid before.
  // This is separate from profile.payees because it's populated by
  // recordPayerHistory(), which is called after evaluate() — so the velocity
  // rule's "is this payee new?" check reflects confirmed prior history only,
  // not speculative future state.
  payerPayees: new Map(),

  // Behavioural baseline for trusted accounts — used exclusively by
  // TRUSTED_ACCOUNT_ANOMALY rule. We track which devices and cities a
  // trusted payer normally operates from, so we can detect when they
  // start acting out of character (possible account compromise).
  payerDevices:   new Map(),
  payerLocations: new Map(),
};

// Internal helper — creates a blank profile on first encounter.
function getOrCreateProfile(payer_id) {
  if (!store.payerProfiles.has(payer_id)) {
    store.payerProfiles.set(payer_id, {
      txTimes:          [],
      highValueTxTimes: [],
      payees:           new Set(),
      devices:          [],
      locations:        [],
    });
  }
  return store.payerProfiles.get(payer_id);
}

/*
  updatePayerProfile — MUST be called after evaluate(), never before.

  If we updated the profile first, the current transaction would be part of
  its own velocity window. "Have you sent ₹10k+ in the last 60 seconds?"
  would always include the current ₹10k transaction — which would make the
  very first large payment flag itself. That's wrong. Rules check history,
  then history gets updated.
*/
function updatePayerProfile(tx) {
  const profile = getOrCreateProfile(tx.payer_id);
  const ts = new Date(tx.timestamp).getTime();

  profile.txTimes.push(ts);
  if (Number(tx.amount) >= 10000) profile.highValueTxTimes.push(ts);
  profile.payees.add(tx.payee_id);
  profile.devices.push(tx.device_id);
  if (tx.location) profile.locations.push(tx.location);
}

/*
  recordPayerHistory — also called after evaluate().

  Populates knownPayers (for velocity tier classification) and payerPayees
  (for the "is this a new payee?" check inside the velocity rule).

  These are kept separate from payerProfiles because they serve a different
  purpose — tier logic — and we wanted the separation to be explicit in code
  so it's clear which data structure each rule is reading from.
*/
function recordPayerHistory(payerId, payeeId) {
  store.knownPayers.add(payerId);
  if (!store.payerPayees.has(payerId)) {
    store.payerPayees.set(payerId, new Set());
  }
  store.payerPayees.get(payerId).add(payeeId);
}

/*
  recordBaseline — builds the behavioural fingerprint for trusted accounts.

  Called after every transaction (not just trusted ones) so that when a payer
  gets added to TRUSTED_PAYERS later, their history is already captured.
  In practice only the TRUSTED_ACCOUNT_ANOMALY rule reads these maps, and
  it skips non-trusted payers immediately.
*/
function recordBaseline(payerId, deviceId, location) {
  if (!store.payerDevices.has(payerId)) {
    store.payerDevices.set(payerId, new Set());
  }
  store.payerDevices.get(payerId).add(deviceId);

  if (location) {
    if (!store.payerLocations.has(payerId)) {
      store.payerLocations.set(payerId, new Set());
    }
    store.payerLocations.get(payerId).add(location);
  }
}

module.exports = { store, getOrCreateProfile, updatePayerProfile, recordPayerHistory, recordBaseline };
