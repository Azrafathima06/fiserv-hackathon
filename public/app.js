'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let heatmapChart   = null;
let knownIds       = new Set();   // prevent duplicate table rows
let simTotal       = 0;
let simFired       = 0;

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initHeatmap();
  setInterval(poll, 2000);
  poll(); // immediate first load
});

// ── Poll server every 2 s ──────────────────────────────────────────────────────
async function poll() {
  try {
    const [s, f] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/flagged').then(r => r.json()),
    ]);
    updateStats(s);
    updateHeatmap(s.hourlyFlagCounts);
    updateTable(f.items);
  } catch (_) { /* server not ready yet */ }
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function updateStats(s) {
  setText('statTotal',    s.totalTransactions);
  setText('statFlagged',  s.flaggedCount);
  setText('statAvgScore', s.avgRiskScore);
  const rate = s.totalTransactions
    ? Math.round((s.flaggedCount / s.totalTransactions) * 100)
    : 0;
  setText('statFlagRate', rate + '%');
  setText('flaggedCount', s.flaggedCount);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(val)) el.textContent = val;
}

// ── Heatmap ────────────────────────────────────────────────────────────────────
function initHeatmap() {
  const ctx = document.getElementById('heatmapChart').getContext('2d');
  const labels = Array.from({length: 24}, (_, i) => `${String(i).padStart(2,'0')}h`);

  // Red for midnight zone, blue for daytime
  const colors = Array.from({length: 24}, (_, i) => {
    if (i < 4)          return 'rgba(239,68,68,0.75)';
    if (i < 6 || i > 21) return 'rgba(249,115,22,0.65)';
    return 'rgba(59,130,246,0.55)';
  });
  const borders = colors.map(c => c.replace(/[\d.]+\)$/, '1)'));

  heatmapChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Flagged',
        data: new Array(24).fill(0),
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 5,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1f36',
          borderColor: '#1e3352',
          borderWidth: 1,
          titleColor: '#e2eaf5',
          bodyColor: '#6b87a8',
          callbacks: {
            title: items => `Hour ${items[0].label}`,
            label: item  => ` ${item.raw} flagged transaction(s)`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#6b87a8', font: { size: 9 }, maxRotation: 0 },
          grid:  { color: 'rgba(30,51,82,0.5)' },
        },
        y: {
          ticks: { color: '#6b87a8', font: { size: 10 }, stepSize: 1 },
          grid:  { color: 'rgba(30,51,82,0.5)' },
          beginAtZero: true,
        },
      },
    },
  });
}

function updateHeatmap(counts) {
  if (!heatmapChart) return;
  heatmapChart.data.datasets[0].data = counts;
  heatmapChart.update('none');
}

// ── Table ──────────────────────────────────────────────────────────────────────
function updateTable(items) {
  const tbody = document.getElementById('txTableBody');

  const newItems = items.filter(tx => !knownIds.has(tx.id));

  // Show toast for the most critical new arrival (skip first load)
  if (newItems.length > 0 && knownIds.size > 0) {
    const top = [...newItems].sort((a, b) => b.riskScore - a.riskScore)[0];
    showToast(top);
  }
  newItems.forEach(tx => knownIds.add(tx.id));

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row"><td colspan="8">
        <div class="empty-state">
          <div class="empty-icon">🛡️</div>
          <div>No flagged transactions yet</div>
          <div class="empty-sub">Submit a transaction or hit <strong>Start Simulation</strong></div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(tx => {
    const isNew = newItems.some(n => n.id === tx.id);
    const d = new Date(tx.timestamp);
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const simTag = tx.simulated ? '<span class="sim-badge">SIM</span>' : '';

    const scoreColor = tx.riskScore >= 80 ? '#ef4444'
      : tx.riskScore >= 60 ? '#f97316'
      : tx.riskScore >= 40 ? '#f59e0b'
      : '#10b981';

    const ruleTags = (tx.triggeredRules || []).map(r =>
      `<span class="rule-tag" title="${esc(r.reason)}">⚡ ${esc(r.code)}</span>`
    ).join('');

    const amtColor = tx.amount >= 10000 ? 'var(--red)'
      : tx.amount >= 5000 ? 'var(--amber)'
      : 'var(--text)';

    return `
    <tr class="${isNew ? 'row-flash' : ''}">
      <td>
        <div class="cell-time">${time}${simTag}</div>
        <div class="cell-loc">📅 ${date}</div>
        ${tx.location ? `<div class="cell-loc">📍 ${esc(tx.location)}</div>` : ''}
      </td>
      <td><span class="cell-id">${esc(tx.payer_id)}</span></td>
      <td><span class="cell-id">${esc(tx.payee_id)}</span></td>
      <td><span class="cell-id" style="font-size:11px;color:var(--text-muted)">${esc(tx.device_id)}</span></td>
      <td><span class="cell-amt" style="color:${amtColor}">₹${Number(tx.amount).toLocaleString('en-IN')}</span></td>
      <td><span class="badge badge-${tx.riskLevel}">${tx.riskLevel}</span></td>
      <td>
        <div class="score-bar-wrap">
          <div class="score-bar">
            <div class="score-bar-fill" style="width:${tx.riskScore}%;background:${scoreColor}"></div>
          </div>
          <span class="score-num-small" style="color:${scoreColor}">${tx.riskScore}</span>
        </div>
      </td>
      <td><div class="rule-tags">${ruleTags || '—'}</div></td>
    </tr>`;
  }).join('');
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(tx) {
  const el = document.getElementById('toast');
  const levelClass = tx.riskLevel === 'CRITICAL' ? 'toast-critical'
    : tx.riskLevel === 'HIGH'     ? 'toast-high'
    : tx.riskLevel === 'MEDIUM'   ? 'toast-medium'
    : 'toast-clean';

  const icon = tx.riskLevel === 'CRITICAL' ? '🚨'
    : tx.riskLevel === 'HIGH'   ? '⚠️'
    : tx.riskLevel === 'MEDIUM' ? '🔶' : '✅';

  const rules = (tx.triggeredRules || []).map(r => r.code).join(' + ') || 'No rules';

  el.className = `toast ${levelClass}`;
  el.innerHTML = `
    <div class="toast-title">${icon} ${tx.riskLevel} — Score ${tx.riskScore}/100</div>
    <div class="toast-body">
      ${esc(tx.payer_id)} → ${esc(tx.payee_id)}  |  ₹${Number(tx.amount).toLocaleString('en-IN')}<br>
      <span style="opacity:0.8">${esc(rules)}</span>
    </div>
  `;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Submit Transaction ─────────────────────────────────────────────────────────
async function submitTransaction(e) {
  e.preventDefault();
  const btn  = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="sim-spinner" style="width:14px;height:14px;border-width:2px"></div> Evaluating…';

  const data = Object.fromEntries(new FormData(e.target).entries());
  data.amount = Number(data.amount);
  // datetime-local gives "2026-05-28T14:30" — convert or leave blank
  if (!data.timestamp) delete data.timestamp;

  try {
    const res    = await fetch('/api/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);

    renderResultCard(result);
    showToast(result);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg> Evaluate Transaction`;
  }
}

function renderResultCard(result) {
  const card  = document.getElementById('resultCard');
  const badge = document.getElementById('resultBadge');
  const score = document.getElementById('resultScore');
  const rules = document.getElementById('resultRules');
  const arc   = document.getElementById('scoreArc');

  badge.className   = `badge badge-${result.riskLevel}`;
  badge.textContent = result.riskLevel;

  const pct = result.riskScore / 100;
  const circumference = 150.8;
  arc.style.strokeDashoffset = circumference * (1 - pct);
  const arcColor = result.riskScore >= 80 ? '#ef4444'
    : result.riskScore >= 60 ? '#f97316'
    : result.riskScore >= 40 ? '#f59e0b'
    : '#10b981';
  arc.setAttribute('stroke', arcColor);

  score.textContent = result.riskScore;
  score.style.color = arcColor;

  if (result.triggeredRules && result.triggeredRules.length > 0) {
    rules.innerHTML = result.triggeredRules.map(r => `
      <div class="rule-chip">
        <div class="rule-chip-code">⚡ ${esc(r.code)}</div>
        <div class="rule-chip-reason">${esc(r.reason)}</div>
      </div>`).join('');
  } else {
    rules.innerHTML = `<div class="clean-msg">✅ All checks passed — transaction looks clean.</div>`;
  }

  card.classList.remove('hidden');
}

// ── Simulation ─────────────────────────────────────────────────────────────────
async function startSimulation() {
  const btn    = document.getElementById('simulateBtn');
  const banner = document.getElementById('simBanner');
  const bar    = document.getElementById('simProgressBar');

  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  banner.classList.remove('hidden');

  try {
    const res  = await fetch('/api/simulate', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    simTotal = data.total;
    simFired = 0;
    bar.style.width = '0%';

    // Animate the progress bar in sync with simulation
    const step = 100 / simTotal;
    const ticker = setInterval(() => {
      simFired++;
      bar.style.width = Math.min(simFired * step, 100) + '%';
      if (simFired >= simTotal) clearInterval(ticker);
    }, data.intervalMs);

    const duration = simTotal * data.intervalMs + 2500;
    setTimeout(() => {
      banner.classList.add('hidden');
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Start Simulation`;
    }, duration);

  } catch (err) {
    alert(`Simulation error: ${err.message}`);
    banner.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Start Simulation`;
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
