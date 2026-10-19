import dotenv from 'dotenv';
dotenv.config();

const SITE_URL = process.env.SITE_URL || 'https://spinwheel.dostt.in';
const SLACK_WEBHOOK_URL = process.env.MONITOR_SLACK_WEBHOOK_URL;
const SLOW_THRESHOLD_MS = 5000;
const WATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const checks = [
  {
    name: 'Health check',
    path: '/health',
    validate: (body) => body?.status === 'ok',
  },
  {
    name: 'Config API',
    path: '/api/config',
    validate: (body) => Array.isArray(body?.wheelSections) && body.wheelSections.length > 0,
  },
];

async function runCheck(check) {
  const url = `${SITE_URL}${check.path}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const ms = Date.now() - start;

    if (!res.ok) {
      return { ok: false, name: check.name, error: `HTTP ${res.status} ${res.statusText}`, ms };
    }

    const body = await res.json();

    if (check.validate && !check.validate(body)) {
      return { ok: false, name: check.name, error: `Unexpected response: ${JSON.stringify(body).slice(0, 120)}`, ms };
    }

    if (ms > SLOW_THRESHOLD_MS) {
      return { ok: false, name: check.name, error: `Slow response: ${ms}ms (threshold ${SLOW_THRESHOLD_MS}ms)`, ms };
    }

    return { ok: true, name: check.name, ms };
  } catch (err) {
    return { ok: false, name: check.name, error: err.message, ms: Date.now() - start };
  }
}

async function sendSlackAlert(failures) {
  if (!SLACK_WEBHOOK_URL) {
    console.error('MONITOR_SLACK_WEBHOOK_URL not set — skipping Slack alert');
    return;
  }

  const lines = failures.map(f => `❌ *${f.name}*: ${f.error} (${f.ms}ms)`).join('\n');
  const payload = {
    text: `🚨 *spinwheel.dostt.in is having issues!*\n\n${lines}\n\n_Checked at ${new Date().toISOString()}_`,
  };

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Slack alert failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('Slack alert error:', err.message);
  }
}

async function runOnce() {
  console.log(`[${new Date().toISOString()}] Checking ${SITE_URL}...`);

  const results = await Promise.all(checks.map(runCheck));
  const failures = results.filter(r => !r.ok);

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const detail = r.ok ? `${r.ms}ms` : r.error;
    console.log(`  ${icon} ${r.name}: ${detail}`);
  }

  if (failures.length > 0) {
    console.log(`  → ${failures.length} check(s) failed. Sending Slack alert...\n`);
    await sendSlackAlert(failures);
    return false;
  } else {
    console.log(`  → All checks passed ✓\n`);
    return true;
  }
}

const watchMode = process.argv.includes('--watch');

if (watchMode) {
  console.log(`🔁 Watch mode — checking every 5 minutes. Press Ctrl+C to stop.\n`);
  runOnce();
  setInterval(runOnce, WATCH_INTERVAL_MS);
} else {
  runOnce().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
    console.error('Monitor crashed:', err);
    process.exit(1);
  });
}
