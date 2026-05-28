/*
  rules.js — the actual fraud brain.

  Each rule is self-contained: it gets the current transaction + the payer's
  historical profile, and returns whether it fired and why. Nothing here does
  I/O or touches the database — pure logic, easy to unit test.

  Scoring: rules add points (weights). Total is capped at 100.
  A transaction is FLAGGED once the score hits 40 or above.

  Why 40 as the threshold? Below 40, a single low-confidence signal
  (like an unusual hour alone) doesn't flag. You need either one strong
  rule or two weaker ones stacking — that reduces false positives on
  legitimate edge cases like someone paying a new merchant at 11 PM.
*/

const { store } = require('./store');

// Accounts we explicitly trust with a much higher velocity ceiling.
// In a real deployment this would come from a config file or admin panel —
// hardcoded here for the hackathon scope.
const TRUSTED_PAYERS = new Set(["PAYROLL_DEPT_22", "BUSINESS_ACC_01"]);

// Three tiers because "known" vs "unknown" is not binary in real UPI traffic.
// A payroll system firing 40 transactions a day is normal. A new number
// firing 11 in 5 minutes is almost certainly fraud or a scripted attack.
const VELOCITY_THRESHOLDS = { trusted: 50, known: 20, unknown: 10 };

const FLAG_THRESHOLD = 40;

const RULES = [

  {
    code: 'HIGH_AMOUNT_VELOCITY',
    label: '₹10k+ in <1 min',
    description: 'Same payer sent ₹10,000+ twice within a 60-second window.',
    weight: 45,
    check(tx, profile) {
      // Skip immediately if this transaction is under ₹10k —
      // no point doing the time window calculation at all.
      if (Number(tx.amount) < 10000) return { triggered: false };

      const now = new Date(tx.timestamp).getTime();

      // Rolling 60-second window. We use the transaction's own timestamp
      // (not Date.now()) so simulated transactions with past timestamps
      // still evaluate correctly against their historical context.
      const recent = (profile?.highValueTxTimes ?? []).filter(t => t >= now - 60_000);

      if (recent.length >= 1) {
        return {
          triggered: true,
          reason: `₹${Number(tx.amount).toLocaleString('en-IN')} sent — ${recent.length} high-value tx in last 60s from same account`,
        };
      }
      return { triggered: false };
    },
  },

  {
    code: 'HIGH_VELOCITY',
    label: 'Velocity limit exceeded',
    description: 'Payer exceeded their tier velocity threshold in a 5-minute rolling window.',
    // weight here is a fallback — this rule returns a dynamic score
    // because the risk level depends on whether the payee is new or known.
    // A known payee at high velocity is low risk (+5). A new payee at
    // high velocity is a red flag (+30). Same rule, very different outcomes.
    weight: 40,
    check(tx, profile) {
      const now = new Date(tx.timestamp).getTime();
      const recent = (profile?.txTimes ?? []).filter(t => t >= now - 5 * 60_000);

      // Look up which tier this payer falls into.
      // This is checked at evaluation time so a payer who just crossed
      // from unknown to known gets the right threshold on their next tx.
      const tier = TRUSTED_PAYERS.has(tx.payer_id) ? 'trusted'
        : store.knownPayers.has(tx.payer_id)       ? 'known'
        : 'unknown';

      const threshold = VELOCITY_THRESHOLDS[tier];

      if (recent.length > threshold) {
        // payerPayees is populated AFTER evaluate() runs, so this check
        // correctly reflects only prior transactions — not the current one.
        const priorPayees = store.payerPayees.get(tx.payer_id);
        const isNewPayee  = !priorPayees || !priorPayees.has(tx.payee_id);

        if (isNewPayee) {
          // High velocity to someone they've never paid = much more suspicious.
          // Could be a money mule setup — rapid small payments to new accounts.
          return {
            triggered:   true,
            dynamicCode: 'HIGH_VELOCITY_NEW_BENEFICIARY',
            score:       30,
            reason: `${recent.length + 1} tx in 5 min (${tier} limit: ${threshold}) — new payee ${tx.payee_id}`,
          };
        } else {
          // High velocity to familiar payees — could just be a batch payment
          // run or refunds. Flag it softly so analysts can check but don't
          // auto-escalate.
          return {
            triggered:   true,
            dynamicCode: 'HIGH_VELOCITY_KNOWN_PAYEES',
            score:       5,
            reason: `${recent.length + 1} tx in 5 min (${tier} limit: ${threshold}) — known payee, low risk`,
          };
        }
      }
      return { triggered: false };
    },
  },

  {
    code: 'FIRST_TIME_PAYEE_HIGH_AMOUNT',
    label: 'New payee + high amount',
    description: 'First payment to this payee and amount exceeds ₹5,000.',
    weight: 40,
    check(tx, profile) {
      // Small amounts to new payees are normal (splitting bills, new shops).
      // It's the combination of "never paid this person before" AND "large
      // amount" that makes this suspicious — social engineering often exploits
      // exactly this pattern (urgency + fake emergency).
      if (Number(tx.amount) <= 5000) return { triggered: false };

      // profile.payees is updated AFTER this check, so a first-time payee
      // won't accidentally see itself as already known.
      const isNew = !profile?.payees.has(tx.payee_id);
      if (isNew) {
        return {
          triggered: true,
          reason: `₹${Number(tx.amount).toLocaleString('en-IN')} paid to first-time payee ${tx.payee_id}`,
        };
      }
      return { triggered: false };
    },
  },

  {
    code: 'DEVICE_CHANGE_NEW_PAYEE',
    label: 'New device + new recipient',
    description: 'Device ID changed from last known AND payee is new.',
    weight: 35,
    check(tx, profile) {
      // Can't detect a device change without at least one prior transaction.
      if (!profile || profile.devices.length === 0) return { triggered: false };

      // We compare against the most recent device, not a set — because if
      // someone legitimately switches phones, the new phone becomes their
      // current device. We care about "different from what they just used",
      // not "different from everything they ever used".
      const lastDevice   = profile.devices[profile.devices.length - 1];
      const deviceChanged = lastDevice !== tx.device_id;
      const isNewPayee   = !profile.payees.has(tx.payee_id);

      // Either signal alone is explainable. New phone = fine. New payee = fine.
      // Both at the same time = classic SIM swap + account takeover pattern.
      if (deviceChanged && isNewPayee) {
        return {
          triggered: true,
          reason: `Device switched ${lastDevice} → ${tx.device_id} while paying new recipient ${tx.payee_id}`,
        };
      }
      return { triggered: false };
    },
  },

  {
    code: 'TRUSTED_ACCOUNT_ANOMALY',
    label: 'Trusted account acting out of character',
    description: 'Trusted payer using an unknown device AND deviating on location, payee, or amount.',
    weight: 50,
    check(tx, profile) {
      // This rule only watches trusted payers — regular accounts already get
      // caught by DEVICE_CHANGE_NEW_PAYEE and FIRST_TIME_PAYEE rules.
      // The problem with trusted accounts is they have a high velocity ceiling,
      // so a hacker with stolen credentials could fire 49 transactions totally
      // undetected. This rule catches the behavioural deviation instead.
      if (!TRUSTED_PAYERS.has(tx.payer_id)) return { triggered: false };

      const knownDevices   = store.payerDevices.get(tx.payer_id);
      const knownLocations = store.payerLocations.get(tx.payer_id);

      // Skip on the very first transaction — no baseline to compare against yet.
      // We need at least one normal transaction to establish what "normal" looks like.
      if (!knownDevices || knownDevices.size === 0) return { triggered: false };

      const newDevice   = !knownDevices.has(tx.device_id);
      const newLocation = knownLocations && tx.location
        ? !knownLocations.has(tx.location) : false;
      const newPayee    = !profile?.payees.has(tx.payee_id);
      const highAmount  = Number(tx.amount) > 5000;

      // One anomaly = probably explainable (new laptop, business travel).
      // Two simultaneous deviations from baseline = statistically very unlikely
      // to be innocent. This is the same two-factor logic banks use for
      // step-up authentication triggers.
      const secondSignal = newLocation || newPayee || highAmount;

      if (newDevice && secondSignal) {
        const signals = [
          newDevice   && `unknown device (${tx.device_id})`,
          newLocation && `new location (${tx.location})`,
          newPayee    && `new payee (${tx.payee_id})`,
          highAmount  && `high amount ₹${Number(tx.amount).toLocaleString('en-IN')}`,
        ].filter(Boolean).join(', ');

        return {
          triggered: true,
          reason: `Trusted account ${tx.payer_id} — anomaly: ${signals}. Possible account compromise.`,
        };
      }
      return { triggered: false };
    },
  },

  {
    code: 'UNUSUAL_HOUR',
    label: 'Midnight window 00:00–03:59',
    description: 'Transaction between midnight and 4 AM.',
    weight: 20,
    check(tx) {
      // Lowest weight of all rules because this alone is weak evidence —
      // someone could legitimately pay a bill at 1 AM. But it stacks with
      // other signals and contributes meaningfully to the total score.
      // Using the transaction's timestamp (not server time) so simulated
      // transactions with planted 2 AM timestamps evaluate correctly.
      const hour = new Date(tx.timestamp).getHours();
      if (hour >= 0 && hour < 4) {
        const t = new Date(tx.timestamp);
        const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
        return {
          triggered: true,
          reason: `Transaction at ${timeStr} — high-risk overnight window`,
        };
      }
      return { triggered: false };
    },
  },

];

function getRiskLevel(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

function evaluate(tx, profile) {
  const triggeredRules = [];
  let total = 0;

  for (const rule of RULES) {
    const result = rule.check(tx, profile);
    if (result.triggered) {
      // dynamicCode and score are only returned by the velocity rule,
      // which needs to emit different identifiers depending on context.
      // All other rules use their static code and weight as normal.
      const effectiveCode  = result.dynamicCode ?? rule.code;
      const effectiveScore = result.score       ?? rule.weight;
      triggeredRules.push({ code: effectiveCode, label: rule.label, weight: effectiveScore, reason: result.reason });
      total += effectiveScore;
    }
  }

  // Cap at 100 so the UI score ring makes sense visually —
  // a score of 135 is not more useful to an analyst than CRITICAL.
  const riskScore = Math.min(total, 100);
  return {
    riskScore,
    riskLevel: getRiskLevel(riskScore),
    flagged: riskScore >= FLAG_THRESHOLD,
    triggeredRules,
  };
}

module.exports = { evaluate, RULES, FLAG_THRESHOLD, TRUSTED_PAYERS, VELOCITY_THRESHOLDS };
