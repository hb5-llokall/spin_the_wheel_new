// Admin Dashboard JS

const API = {
  headers() {
    return {
      'Content-Type': 'application/json',
      'x-admin-user': sessionStorage.getItem('admin_user') || '',
      'x-admin-pass': sessionStorage.getItem('admin_pass') || '',
    };
  },
  async get(path) {
    const res = await fetch(path, { headers: this.headers() });
    let data;
    try { data = await res.json(); } catch { throw new Error(`Server error ${res.status} — possibly timed out. Try again.`); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  async post(path, body = {}) {
    const res = await fetch(path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    let data;
    try { data = await res.json(); } catch { throw new Error(`Server error ${res.status} — possibly timed out. Try again.`); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
};

// ── Theme ─────────────────────────────────────────────────────────────────────
// Always start dark on page load — light is only active while toggled in this session
localStorage.removeItem('admin_theme');

document.getElementById('themeBtn').addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light');
  document.getElementById('themeBtn').textContent = isLight ? '🌙 Dark' : '☀️ Light';
});

// ── Auth ─────────────────────────────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('adminUser').value.trim();
  const password = document.getElementById('adminPass').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(async r => { if (!r.ok) throw new Error('Invalid credentials'); });
    sessionStorage.setItem('admin_user', username);
    sessionStorage.setItem('admin_pass', password);
    showDashboard();
  } catch {
    errEl.textContent = 'Invalid username or password';
  }
});

document.getElementById('adminPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.clear();
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
});

function isLoggedIn() {
  return sessionStorage.getItem('admin_user') && sessionStorage.getItem('admin_pass');
}

if (isLoggedIn()) showDashboard();

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ── Loading ───────────────────────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('loadingOverlay').classList.toggle('hidden', !on);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function showDashboard() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  setLoading(true);
  try {
    await Promise.all([loadVisual(), loadDataTab(), loadFailedTransfers()]);
  } finally {
    setLoading(false);
  }
}

// ── CSV Util ──────────────────────────────────────────────────────────────────
function downloadCSV(data, filename) {
  if (!data.length) return alert('No data to download');
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── DDR helper ────────────────────────────────────────────────────────────────
function ddrTag(today, yesterday) {
  if (!yesterday) return { text: '→ No data yesterday', cls: 'ddr-flat' };
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct > 0) return { text: `↑ +${pct}% vs ${Number(yesterday).toLocaleString()} yesterday`, cls: 'ddr-up' };
  if (pct < 0) return { text: `↓ ${pct}% vs ${Number(yesterday).toLocaleString()} yesterday`, cls: 'ddr-down' };
  return { text: `→ Same as yesterday (${Number(yesterday).toLocaleString()})`, cls: 'ddr-flat' };
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
const CHART_COLORS = ['#6366f1','#22d3ee','#f59e0b','#10b981','#f43f5e','#a855f7','#fb923c','#34d399'];

function fillDates(rows, key = 'date', valueKey = 'count', days = 30) {
  const map = Object.fromEntries(rows.map(r => [r[key], Number(r[valueKey])]));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const label = d.toISOString().slice(0, 10);
    result.push({ label, value: map[label] || 0 });
  }
  return result;
}

function makeLineChart(canvasId, label, data, color = CHART_COLORS[0]) {
  const ctx = document.getElementById(canvasId);
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.label),
      datasets: [{ label, data: data.map(d => d.value), borderColor: color, backgroundColor: color + '22', tension: 0.4, fill: true, pointRadius: 3 }],
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 } }, y: { ticks: { color: '#94a3b8' }, beginAtZero: true } } },
  });
}

function makeBarChart(canvasId, label, data, color = CHART_COLORS[1]) {
  const ctx = document.getElementById(canvasId);
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [{ label, data: data.map(d => d.value), backgroundColor: color + 'cc', borderRadius: 4 }],
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 } }, y: { ticks: { color: '#94a3b8' }, beginAtZero: true } } },
  });
}

function makePieChart(canvasId, labels, values) {
  const ctx = document.getElementById(canvasId);
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: CHART_COLORS, borderWidth: 2, borderColor: '#1e293b' }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#e2e8f0', padding: 12 } } } },
  });
}

function makeDDRChart(canvasId, title, filledData, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  const todayVal = filledData.at(-1).value;
  const yestVal  = filledData.at(-2).value;
  const pct = yestVal ? Math.round(((todayVal - yestVal) / yestVal) * 100) : null;
  const pctLabel = pct === null ? '' : pct > 0 ? ` ↑ +${pct}%` : pct < 0 ? ` ↓ ${pct}%` : ' → same';

  const labels = filledData.map((d, i) => {
    if (i === filledData.length - 1) return `Today${pctLabel}`;
    return d.label.slice(5); // MM-DD
  });
  const bgColors = filledData.map((d, i) =>
    i === filledData.length - 1 ? color + 'ee' : color + '44'
  );

  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: filledData.map(d => d.value),
        backgroundColor: bgColors,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: title, color: '#e2e8f0', font: { size: 13, weight: '600' }, padding: { bottom: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => {
              const isToday = item.dataIndex === filledData.length - 1;
              return isToday
                ? `${Number(item.raw).toLocaleString()} (today so far)`
                : Number(item.raw).toLocaleString();
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8' }, beginAtZero: true, grid: { color: '#334155' } },
      },
    },
  });
}

function makeStackedBarChart(canvasId, labels, datasets) {
  const ctx = document.getElementById(canvasId);
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: { responsive: true, scales: { x: { stacked: true, ticks: { color: '#94a3b8', maxTicksLimit: 8 } }, y: { stacked: true, ticks: { color: '#94a3b8' }, beginAtZero: true } }, plugins: { legend: { labels: { color: '#e2e8f0' } } } },
  });
}

// ── Visual Tab ────────────────────────────────────────────────────────────────
let cachedStats = null;

async function loadVisual() {
  const stats = await API.get('/api/admin/stats');
  cachedStats = stats;

  // Overview cards
  const o = stats.overview;
  const cards = [
    { label: 'Total Players', value: o.total_players, sub: `+${o.today_new_players} new today`, color: '#6366f1' },
    { label: 'Today Active', value: o.today_active_players, sub: `${o.today_spins} spins today`, color: '#22d3ee' },
    { label: 'Total Spins', value: o.total_spins, sub: 'All time', color: '#818cf8' },
    { label: 'Coins Won', value: o.total_coins_won, sub: `Avg ${o.avg_coins_per_active_player} per active player`, color: '#f59e0b' },
    { label: 'Coins Transferred', value: o.total_coins_transferred, sub: `${o.total_successful_transfers} successful transfers`, color: '#10b981' },
    { label: 'Pending in Wallets', value: o.pending_coins, sub: 'Won but not transferred', color: '#a855f7' },
    { label: 'Transfer Rate', value: `${o.transfer_rate_pct}%`, sub: `${o.players_transferred} of ${o.total_players} players`, color: '#34d399' },
    { label: 'Failed Transfers', value: o.total_failed_transfers, sub: 'Needs attention', color: '#f43f5e' },
    { label: 'Never Spun', value: o.registered_never_spun, sub: 'Registered but no spin', color: '#64748b' },
    { label: 'Absolute Cost', value: `₹${Number(o.absolute_cost).toLocaleString()}`, sub: 'Coins transferred × ₹0.22', color: '#e11d48' },
    { label: 'Net Cost', value: `₹${Number(o.net_cost).toLocaleString()}`, sub: 'Coins transferred × ₹0.10', color: '#be185d' },
  ];
  document.getElementById('overviewCards').innerHTML = cards.map(c => `
    <div class="stat-card" style="border-top:3px solid ${c.color}">
      <p class="stat-label">${c.label}</p>
      <p class="stat-value" style="color:${c.color}">${typeof c.value === 'number' ? Number(c.value).toLocaleString() : c.value}</p>
      <p class="stat-sub">${c.sub}</p>
    </div>`).join('');

  // Charts
  const { charts, retention, behaviour } = stats;

  const filledSpins      = fillDates(charts.dailySpins, 'date', 'count');
  const filledPlayers    = fillDates(charts.dailyPlayers, 'date', 'count');
  const filledDAU        = fillDates(charts.dailyActiveUsers, 'date', 'count');
  const filledCoinsWon   = fillDates(charts.dailyCoinsWon, 'date', 'count');
  const filledCoinsXfer  = fillDates(charts.dailyCoinsTransferred, 'date', 'count');

  makeLineChart('chartSpins', 'Spins per Day', filledSpins, CHART_COLORS[0]);
  makeBarChart('chartPlayers', 'New Players per Day', filledPlayers, CHART_COLORS[1]);
  makeLineChart('chartDAU', 'Daily Active Users', filledDAU, CHART_COLORS[2]);
  makeLineChart('chartCoinsWon', 'Coins Won per Day', filledCoinsWon, CHART_COLORS[5]);
  makeBarChart('chartCoinsTransferred', 'Coins Transferred per Day', filledCoinsXfer, CHART_COLORS[3]);

  // Stacked bar: transfers success vs failed
  const dateMap = {};
  for (const row of charts.dailyTransfers) {
    if (!dateMap[row.date]) dateMap[row.date] = { success: 0, failed: 0 };
    if (['success', 'mock_success', 'submitted'].includes(row.status)) dateMap[row.date].success += Number(row.count);
    else dateMap[row.date].failed += Number(row.count);
  }
  const tDates = fillDates([], 'date', 'count');

  // DDR chart cards — same-time-of-day comparison for last 7 days
  // Falls back to full-day slice if the endpoint isn't available yet
  const todayLabel = tDates.at(-1).label;
  const yestLabel  = tDates.at(-2).label;
  const ddrSeries = await API.get('/api/admin/ddr-series').catch(() => null);
  if (ddrSeries && ddrSeries.length) {
    const toFilled = (key) => ddrSeries.map(r => ({ label: r.date, value: r[key] || 0 }));
    makeDDRChart('ddrSpins',     'Spins (same time)',               toFilled('spins'),             CHART_COLORS[0]);
    makeDDRChart('ddrPlayers',   'New Players (same time)',          toFilled('new_players'),       CHART_COLORS[1]);
    makeDDRChart('ddrDAU',       'Active Users (same time)',         toFilled('active_users'),      CHART_COLORS[2]);
    makeDDRChart('ddrCoinsWon',  'Coins Won (same time)',            toFilled('coins_won'),         CHART_COLORS[5]);
    makeDDRChart('ddrCoinsXfer', 'Coins Transferred (same time)',    toFilled('coins_transferred'), CHART_COLORS[3]);
    makeDDRChart('ddrTransfers', 'Transfers Success (same time)',    toFilled('transfers_success'), '#38bdf8');
  } else {
    const filledTransferSuccess = fillDates(
      charts.dailyTransfers.filter(r => ['success','mock_success','submitted'].includes(r.status)),
      'date', 'count'
    );
    makeDDRChart('ddrSpins',     'Spins',               filledSpins.slice(-7),             CHART_COLORS[0]);
    makeDDRChart('ddrPlayers',   'New Players',          filledPlayers.slice(-7),           CHART_COLORS[1]);
    makeDDRChart('ddrDAU',       'Active Users',         filledDAU.slice(-7),               CHART_COLORS[2]);
    makeDDRChart('ddrCoinsWon',  'Coins Won',            filledCoinsWon.slice(-7),          CHART_COLORS[5]);
    makeDDRChart('ddrCoinsXfer', 'Coins Transferred',    filledCoinsXfer.slice(-7),         CHART_COLORS[3]);
    makeDDRChart('ddrTransfers', 'Transfers (Success)',  filledTransferSuccess.slice(-7),   '#38bdf8');
  }

  makeStackedBarChart('chartTransfers', tDates.map(d => d.label), [
    { label: 'Success', data: tDates.map(d => dateMap[d.label]?.success || 0), backgroundColor: '#10b981cc', borderRadius: 2 },
    { label: 'Failed', data: tDates.map(d => dateMap[d.label]?.failed || 0), backgroundColor: '#f43f5ecc', borderRadius: 2 },
  ]);

  // Transfer status pie
  const tsLabels = charts.transferStatusBreakdown.map(r => r.status);
  const tsValues = charts.transferStatusBreakdown.map(r => Number(r.count));
  makePieChart('chartTransferStatus', tsLabels, tsValues);

  // Rewards pie
  const rlLabels = charts.rewardsBreakdown.map(r => r.reward_key);
  const rlValues = charts.rewardsBreakdown.map(r => Number(r.count));
  makePieChart('chartRewards', rlLabels, rlValues);

  // Retention bar — only show bars with n>=30 (reliable), rest show as 0 with note
  const MIN_SAMPLE = 30;
  const retData = [
    { label: 'Day 1', value: Number(retention.day1) || 0, n: retention.n_d1 || 0 },
    { label: 'Day 3', value: Number(retention.day3) || 0, n: retention.n_d3 || 0 },
    { label: 'Day 7', value: Number(retention.day7) || 0, n: retention.n_d7 || 0 },
    { label: 'Day 14', value: Number(retention.day14) || 0, n: retention.n_d14 || 0 },
    { label: 'Day 30', value: Number(retention.day30) || 0, n: retention.n_d30 || 0 },
  ];
  const retColors = retData.map(d => d.n >= MIN_SAMPLE ? CHART_COLORS[3] + 'cc' : '#1e293b');
  const retCtx = document.getElementById('chartRetention');
  if (retCtx._chart) retCtx._chart.destroy();
  retCtx._chart = new Chart(retCtx, {
    type: 'bar',
    data: {
      labels: retData.map(d => d.n >= MIN_SAMPLE ? `${d.label} (${d.value}%)` : `${d.label}\n(need more data)`),
      datasets: [{
        label: 'Retention % (returned within N days)',
        data: retData.map(d => d.n >= MIN_SAMPLE ? d.value : 0),
        backgroundColor: retColors,
        borderRadius: 4
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#e2e8f0' } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = retData[ctx.dataIndex];
              return d.n >= MIN_SAMPLE
                ? `Retention: ${d.value}% (${d.n} players)`
                : `Not enough data yet (n=${d.n}, need ${MIN_SAMPLE}+)`;
            }
          }
        }
      },
      scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' }, beginAtZero: true, max: 100 } }
    },
  });

  // Behaviour cards
  const b = behaviour;
  const bCards = [
    { label: 'Full Engagement Today', value: b.full_engagement_today || 0, sub: 'Used all 3 spins today', color: '#10b981' },
    { label: 'Never Transferred', value: b.never_transferred || 0, sub: 'Has coins, never transferred', color: '#f59e0b' },
    { label: 'Has Coins, Not Transferred', value: b.has_coins_never_transferred || 0, sub: 'Potential lost conversions', color: '#fb923c' },
    { label: 'Streak Players', value: b.streak_players || 0, sub: '3+ days active this week', color: '#34d399' },
    { label: 'Churned (7 days)', value: b.churned_7days || 0, sub: 'No spin in 7 days', color: '#f43f5e' },
    { label: 'Churned (30 days)', value: b.churned_30days || 0, sub: 'No spin in 30 days', color: '#ef4444' },
  ];
  document.getElementById('behaviourCards').innerHTML = bCards.map(c => `
    <div class="stat-card" style="border-top:3px solid ${c.color}">
      <p class="stat-label">${c.label}</p>
      <p class="stat-value" style="color:${c.color}">${Number(c.value).toLocaleString()}</p>
      <p class="stat-sub">${c.sub}</p>
    </div>`).join('');

  // Top players table
  const tbody = document.querySelector('#topPlayersTable tbody');
  tbody.innerHTML = b.topPlayers.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${p.mobile_number}</td>
      <td>${p.display_name || '—'}</td>
      <td>${p.total_spins || 0}</td>
      <td>${p.total_coins}</td>
      <td>${p.transferred}</td>
      <td><strong>${p.wallet_balance}</strong></td>
      <td>${p.last_spin || '—'}</td>
    </tr>`).join('');

  await loadRewardEngine().catch(() => {
    document.getElementById('rewardEngineStatus').textContent = '— not available (run the reward engine migration)';
  });
}

// ── Reward Engine ─────────────────────────────────────────────────────────────
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtNum = (value, digits = 0) => (value == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }));
const fmtPct = (value) => (value == null ? '—' : `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}%`);

async function loadRewardEngine() {
  const data = await API.get('/api/admin/reward-engine');
  const last = data.runs.find((r) => r.status === 'success');
  const s = last?.summary || {};
  document.getElementById('rewardEngineStatus').textContent =
    `— ${data.mode.toUpperCase()} · ${data.engineVersion}` +
    (data.runs[0] ? ` · last run ${new Date(data.runs[0].started_at).toLocaleString()} (${data.runs[0].status})` : ' · no run yet');

  const cards = [
    { label: 'Regular payers scored', value: fmtNum(s.populationSize), sub: last ? `scored for ${last.scoring_date}` : 'no successful run' },
    { label: 'Median score', value: fmtNum(s.medianScore, 1), sub: `coins/share ${fmtNum(s.coinsPerShare, 1)}` },
    { label: 'All payers vs budget', value: fmtPct(s.populationVsBudgetPct), sub: `${fmtNum(s.populationCoins)} of ${fmtNum(s.budgetCoins)} coins` },
    { label: 'New plans tonight', value: fmtNum(s.newPlans), sub: `${fmtNum(s.plannedCoins)} coins planned` },
    ...Object.entries(s.segments || {}).map(([segment, n]) => ({ label: `Spin-active: ${segment}`, value: fmtNum(n), sub: 'as of scoring date' }))
  ];
  document.getElementById('rewardRunCards').innerHTML = cards.map((c, i) => `
    <div class="stat-card" style="border-top:3px solid ${CHART_COLORS[i % CHART_COLORS.length]}">
      <p class="stat-label">${escapeHtml(c.label)}</p>
      <p class="stat-value" style="color:${CHART_COLORS[i % CHART_COLORS.length]}">${escapeHtml(c.value)}</p>
      <p class="stat-sub">${escapeHtml(c.sub)}</p>
    </div>`).join('');

  document.querySelector('#rewardRunsTable tbody').innerHTML = data.runs.map((r) => {
    const rs = r.summary || {};
    const plannedPct = rs.plannedBudgetCoins ? (rs.plannedCoins / rs.plannedBudgetCoins - 1) * 100 : null;
    const arms = Object.entries(rs.arms || {}).map(([a, n]) => `${a}: ${n}`).join('<br>');
    return `
    <tr>
      <td>${escapeHtml(r.scoring_date)}</td>
      <td>${escapeHtml(r.plan_start_date)}</td>
      <td>${escapeHtml(r.mode)}</td>
      <td title="${escapeHtml(r.error || '')}">${escapeHtml(r.status)}</td>
      <td>${fmtNum(r.population_size)}</td>
      <td>${fmtNum(r.median_score, 1)}</td>
      <td>${fmtNum(r.coins_per_share, 1)}</td>
      <td>${fmtPct(rs.populationVsBudgetPct)}</td>
      <td>${fmtNum(rs.storedPlans)}</td>
      <td>${fmtPct(plannedPct)}</td>
      <td>${arms || '—'}</td>
      <td>${rs.dailyCap?.capped ? `scaled ×${rs.dailyCap.scale}` : 'no'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12">No runs yet</td></tr>';

  const bands = Object.entries(s.coinsByScoreBand || {})
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10));
  const bandCoins = bands.reduce((sum, [, b]) => sum + b.coins, 0);
  document.querySelector('#rewardBandsTable tbody').innerHTML = bands.map(([band, b]) => `
    <tr>
      <td>${escapeHtml(band)}</td>
      <td>${fmtNum(b.users)}</td>
      <td>${fmtNum(b.coins / b.users)}</td>
      <td>${fmtNum(b.coins)}</td>
      <td>${bandCoins ? ((100 * b.coins) / bandCoins).toFixed(1) : '—'}%</td>
    </tr>`).join('') || '<tr><td colspan="5">No scores yet</td></tr>';

  document.querySelector('#rewardRedemptionTable tbody').innerHTML = data.redemption.map((r) => `
    <tr>
      <td>${r.run_id == null ? 'at spin' : `#${escapeHtml(r.run_id)}`}</td>
      <td>${escapeHtml(r.mode)}</td>
      <td>${escapeHtml(r.segment)}</td>
      <td>${escapeHtml(r.arm)}</td>
      <td>${fmtNum(r.plans)}</td>
      <td>${fmtNum(r.planned_coins)}</td>
      <td><strong>${fmtNum(r.redeemed_coins)}</strong></td>
      <td>${r.planned_coins ? ((100 * r.redeemed_coins) / r.planned_coins).toFixed(1) : '—'}%</td>
    </tr>`).join('') || '<tr><td colspan="8">No plans in the last 30 days</td></tr>';
}

async function loadRewardPlayer() {
  const input = document.getElementById('rewardPlayerInput').value.trim();
  const label = document.getElementById('rewardPlayerLabel');
  if (!input) return;
  const digits = input.replace(/\D/g, '');
  const query = digits.length >= 10 ? `mobile=${encodeURIComponent(digits)}` : `dosttUserId=${encodeURIComponent(digits)}`;
  try {
    const { plans } = await API.get(`/api/admin/reward-engine/player?${query}`);
    label.textContent = plans.length ? `${plans.length} plan(s)` : 'No plans for this player';
    document.querySelector('#rewardPlayerTable tbody').innerHTML = plans.map((p) => {
      const sc = p.scores;
      const score = sc ? `<strong>${sc.total}</strong> (${sc.money} · ${sc.calls} · ${sc.shopping} · ${sc.wallet} · ${sc.profile})` : '—';
      const byDay = {};
      for (const c of p.cards) (byDay[c.day] = byDay[c.day] || []).push(`${c.coins || 'BL'}${c.drawn_at ? '✓' : ''}`);
      const cardsHtml = Object.entries(byDay).map(([day, cs]) => `D${day}: ${escapeHtml(cs.join(' '))}`).join('<br>');
      return `
      <tr>
        <td>#${escapeHtml(p.id)}</td>
        <td>made ${escapeHtml(p.start_date)}<br>spin day ${escapeHtml(p.spin_days)}/5${p.last_spin_date ? ` (last ${escapeHtml(p.last_spin_date)})` : ''}<br>${p.ended_at ? 'ended' : 'open'}</td>
        <td>${escapeHtml(p.mode)}</td>
        <td>${escapeHtml(p.segment)}${p.arm ? `<br>${escapeHtml(p.arm)}` : ''}</td>
        <td>${score}</td>
        <td>${fmtNum(p.median_score, 1)}</td>
        <td>${fmtNum(p.share, 3)}</td>
        <td><strong>${fmtNum(p.total_coins)}</strong>${p.scored_coins != null && p.scored_coins !== p.total_coins ? ` (scored ${fmtNum(p.scored_coins)})` : ''}</td>
        <td>${escapeHtml((p.deck || []).join(' · '))}</td>
        <td>${cardsHtml}</td>
      </tr>`;
    }).join('');
  } catch (error) {
    label.textContent = error.message;
  }
}

document.getElementById('rewardPlayerBtn')?.addEventListener('click', loadRewardPlayer);

// ── Data Tab ──────────────────────────────────────────────────────────────────
let dataCache = { players: [], spins: [], transfers: [] };

async function loadDataTab() {
  const [players, spins, transfers] = await Promise.all([
    API.get('/api/admin/data/players'),
    API.get('/api/admin/data/spins'),
    API.get('/api/admin/data/transfers'),
  ]);
  dataCache = { players, spins, transfers };
  renderTable('playersTable', players, ['id','mobile_number','display_name','total_coins','transferred_coins','wallet_balance','total_spins','created_at']);
  renderTable('spinsTable', spins, ['id','mobile_number','display_name','reward_key','coin_value','spin_date','created_at']);
  renderTable('transfersTable', transfers, ['id','mobile_number','display_name','coins_requested','status','error_message','wallet_balance','transfer_date']);
}

function renderTable(tableId, rows, keys) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="20" class="empty-row">No data</td></tr>'; return; }
  tbody.innerHTML = rows.map(row => `<tr>${keys.map(k => `<td>${row[k] ?? '—'}</td>`).join('')}</tr>`).join('');
}

document.getElementById('filterSpinsBtn').addEventListener('click', async () => {
  const date = document.getElementById('spinDateFilter').value;
  const spins = await API.get(`/api/admin/data/spins${date ? `?date=${date}` : ''}`);
  dataCache.spins = spins;
  renderTable('spinsTable', spins, ['id','mobile_number','display_name','reward_key','coin_value','spin_date','created_at']);
});

document.getElementById('filterTransfersBtn').addEventListener('click', async () => {
  const date = document.getElementById('transferDateFilter').value;
  const mobile = document.getElementById('transferMobileFilter').value;
  const status = document.getElementById('transferStatusFilter').value;
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (mobile) params.set('mobile', mobile);
  if (status) params.set('status', status);
  const transfers = await API.get(`/api/admin/data/transfers?${params}`);
  dataCache.transfers = transfers;
  renderTable('transfersTable', transfers, ['id','mobile_number','display_name','coins_requested','status','error_message','wallet_balance','transfer_date']);
});

// CSV download buttons
document.querySelectorAll('.dl-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    downloadCSV(dataCache[type] || [], `${type}-${new Date().toISOString().slice(0,10)}.csv`);
  });
});

document.getElementById('ftDownloadBtn').addEventListener('click', () => {
  downloadCSV(failedCache, `failed-transfers-${new Date().toISOString().slice(0,10)}.csv`);
});

// ── Failed Transfers Tab ──────────────────────────────────────────────────────
let failedCache = [];

async function loadFailedTransfers(filters = {}) {
  const qs = (status) => {
    const p = new URLSearchParams({ status });
    if (filters.date) p.set('date', filters.date);
    if (filters.mobile) p.set('mobile', filters.mobile);
    return p.toString();
  };

  const [failed1, failed2] = await Promise.all([
    API.get(`/api/admin/data/transfers?${qs('failed_provider')}`),
    API.get(`/api/admin/data/transfers?${qs('failed_not_registered')}`),
  ]);
  failedCache = [...failed1, ...failed2].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Show filter status
  const filterParts = [];
  if (filters.date) filterParts.push(`date: ${filters.date}`);
  if (filters.mobile) filterParts.push(`mobile: ${filters.mobile}`);
  const filterLabel = document.getElementById('ftFilterLabel');
  if (filterLabel) {
    filterLabel.textContent = filterParts.length
      ? `Showing ${failedCache.length} results for ${filterParts.join(', ')}`
      : `Showing all ${failedCache.length} failed transfers`;
  }

  renderFailedTable(failedCache);
}

function renderFailedTable(rows) {
  const tbody = document.querySelector('#failedTable tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-row">No failed transfers 🎉</td></tr>'; return; }
  tbody.innerHTML = rows.map(row => `
    <tr id="frow-${row.id}">
      <td>${row.id}</td>
      <td>${row.mobile_number}</td>
      <td>${row.display_name || '—'}</td>
      <td>${row.coins_requested}</td>
      <td><span class="status-badge status-${row.status}">${row.status}</span></td>
      <td class="error-cell">${row.error_message || '—'}</td>
      <td><strong>${row.wallet_balance}</strong></td>
      <td>${row.transfer_date || '—'}</td>
      <td>
        <button class="retry-btn" data-id="${row.id}" ${row.wallet_balance <= 0 ? 'disabled title="No balance"' : ''}>
          Retry
        </button>
      </td>
    </tr>`).join('');

  document.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', () => retrySingle(Number(btn.dataset.id), btn));
  });
}

async function retrySingle(id, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await API.post(`/api/admin/transfers/${id}/retry`);
    if (result.success) {
      const row = document.getElementById(`frow-${id}`);
      if (row) row.remove();
      showRetryStatus(`✅ Transfer ${id} — ${result.coins} coins sent`, 'success');
    } else {
      btn.textContent = 'Retry';
      btn.disabled = false;
      showRetryStatus(`❌ Retry failed: ${result.message || result.reason}`, 'error');
    }
  } catch (err) {
    btn.textContent = 'Retry';
    btn.disabled = false;
    showRetryStatus(`❌ Error: ${err.message}`, 'error');
  }
}

document.getElementById('retryAllBtn').addEventListener('click', async () => {
  const mobile = document.getElementById('ftMobileFilter').value.trim();
  const rows = [...document.querySelectorAll('#failedTable tbody tr[id^="frow-"]')];
  const ids = rows.map(r => Number(r.id.replace('frow-', ''))).filter(Boolean);
  if (!ids.length) return;
  if (!confirm(`Retry ${ids.length} failed transfers${mobile ? ` for ${mobile}` : ''}? This will attempt to transfer current wallet balances.`)) return;

  const statusEl = document.getElementById('retryStatus');
  statusEl.innerHTML = `⏳ Retrying 0 / ${ids.length}...`;
  statusEl.className = 'retry-status success';
  statusEl.classList.remove('hidden');

  const BATCH = 10;
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await Promise.all(batch.map(async id => {
      try {
        const result = await API.post(`/api/admin/transfers/${id}/retry`);
        if (result.success) {
          succeeded.push(result);
          const row = document.getElementById(`frow-${id}`);
          if (row) row.remove();
        } else {
          failed.push({ id, ...result });
        }
      } catch (e) {
        failed.push({ id, reason: e.message });
      }
    }));
    statusEl.innerHTML = `⏳ Retrying ${Math.min(i + BATCH, ids.length)} / ${ids.length} — ✅ ${succeeded.length} done`;
  }

  showRetryAllSummary(succeeded, failed);
});

// ── Cohort Retention ──────────────────────────────────────────────────────────
document.getElementById('cohortLoadBtn').addEventListener('click', () => {
  const date = document.getElementById('cohortDatePicker').value;
  if (!date) return alert('Please pick a date first');
  loadCohortRetention(date);
});

async function loadCohortRetention(date) {
  const label = document.getElementById('cohortLabel');
  label.textContent = 'Loading...';
  try {
    const data = await API.get(`/api/admin/cohort-retention?date=${date}`);
    const n = data.cohort_size || 0;
    label.textContent = `${n} players registered on ${date}`;

    const bars = [
      { label: 'D1', value: Number(data.d1) || 0 },
      { label: 'D2', value: Number(data.d2) || 0 },
      { label: 'D3', value: Number(data.d3) || 0 },
      { label: 'D4', value: Number(data.d4) || 0 },
      { label: 'D5', value: Number(data.d5) || 0 },
      { label: 'D6', value: Number(data.d6) || 0 },
      { label: 'D7+', value: Number(data.d7plus) || 0 },
      { label: 'D30+', value: Number(data.d30plus) || 0 },
    ];

    const ctx = document.getElementById('chartCohort');
    if (ctx._chart) ctx._chart.destroy();
    ctx._chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: bars.map(b => b.label),
        datasets: [{
          label: `Retention % — cohort of ${n} players (${date})`,
          data: bars.map(b => b.value),
          backgroundColor: bars.map((b, i) => CHART_COLORS[i % CHART_COLORS.length] + 'cc'),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#e2e8f0' } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.y}% of ${n} players (${Math.round(ctx.parsed.y * n / 100)} users)`,
            }
          }
        },
        scales: {
          x: { ticks: { color: '#94a3b8' } },
          y: { ticks: { color: '#94a3b8', callback: v => v + '%' }, beginAtZero: true, max: 100 }
        }
      },
    });
  } catch (err) {
    label.textContent = `Error: ${err.message}`;
  }
}

function showRetryAllSummary(succeeded, failed) {
  const el = document.getElementById('retryStatus');
  const total = succeeded.length + failed.length;
  const reasons = {};
  failed.forEach(r => { reasons[r.reason || 'unknown'] = (reasons[r.reason || 'unknown'] || 0) + 1; });
  const reasonText = Object.entries(reasons).map(([k, v]) => `${v} × ${k}`).join(', ');
  el.innerHTML = `
    <strong>Retry All complete — ${total} processed</strong><br>
    ✅ ${succeeded.length} succeeded &nbsp;|&nbsp; ❌ ${failed.length} failed${reasonText ? ` (${reasonText})` : ''}
    ${succeeded.length ? `<br><span style="color:#94a3b8;font-size:0.8rem">Coins sent: ${succeeded.map(r => r.coins).join(', ')}</span>` : ''}
  `;
  el.className = 'retry-status ' + (succeeded.length > 0 ? 'success' : 'error');
  el.classList.remove('hidden');
}

document.getElementById('ftFilterBtn').addEventListener('click', () => {
  loadFailedTransfers({
    date: document.getElementById('ftDateFilter').value,
    mobile: document.getElementById('ftMobileFilter').value.trim(),
  });
});

document.getElementById('ftClearBtn').addEventListener('click', () => {
  document.getElementById('ftDateFilter').value = '';
  document.getElementById('ftMobileFilter').value = '';
  loadFailedTransfers();
});

function showRetryStatus(msg, type) {
  const el = document.getElementById('retryStatus');
  el.textContent = msg;
  el.className = `retry-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}
