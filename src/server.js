import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createTransferRequest,
  createTransferRequestByDosttId,
  dismissNotification,
  dismissNotificationByDosttId,
  getAdminStats,
  getAdminTableData,
  getCohortRetention,
  getDDRStats,
  getDDRTimeSeries,
  getPlayerState,
  getPlayerStateByDosttId,
  getPublicConfig,
  registerPlayer,
  registerPlayerByDosttId,
  resetTestData,
  retryAllFailed,
  retryTransfer,
  spinForPlayer,
  spinForPlayerByDosttId,
  normalizeMobile
} from './spin-wheel-service.js';
import { startRechargeGateScheduler } from './recharge-gate-scheduler.js';
import { getPlayerRewardPlans, getRewardEngineReport } from './reward-engine.js';
import { startRewardScoringScheduler } from './reward-scoring-scheduler.js';

dotenv.config();

async function sendSlackAlert(text) {
  const url = process.env.MONITOR_SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (_) {}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(publicDir));

function cleanMobileNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }

  return digits;
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'generic-spin-wheel-backend'
  });
});

app.get('/api/config', (_req, res) => {
  res.json(getPublicConfig());
});

app.post('/api/players/register', async (req, res) => {
  try {
    const mobileNumber = cleanMobileNumber(req.body.mobileNumber);
    const displayName = req.body.displayName || null;

    if (mobileNumber.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required' });
    }

    const player = await registerPlayer({ mobileNumber, displayName });
    const state = await getPlayerState(mobileNumber);

    res.status(201).json({
      player,
      state
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/players/:mobileNumber/state', async (req, res) => {
  try {
    const mobileNumber = cleanMobileNumber(req.params.mobileNumber);
    const state = await getPlayerState(mobileNumber);

    if (!state) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Dostt User ID Routes ─────────────────────────────────────────────────────

app.post('/api/players/register-dostt', async (req, res) => {
  try {
    const dosttUserId = parseInt(req.body.dosttUserId, 10);
    if (!dosttUserId || dosttUserId <= 0) {
      return res.status(400).json({ error: 'Valid dosttUserId is required' });
    }
    const player = await registerPlayerByDosttId(dosttUserId);
    const state = await getPlayerStateByDosttId(dosttUserId);
    res.status(201).json({ player, state });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/players/dostt/:dosttUserId/state', async (req, res) => {
  try {
    const dosttUserId = parseInt(req.params.dosttUserId, 10);
    if (!dosttUserId || dosttUserId <= 0) {
      return res.status(400).json({ error: 'Valid dosttUserId is required' });
    }
    const state = await getPlayerStateByDosttId(dosttUserId);
    if (!state) return res.status(404).json({ error: 'Player not found' });
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/players/dostt/:dosttUserId/dismiss-notification', async (req, res) => {
  try {
    const dosttUserId = parseInt(req.params.dosttUserId, 10);
    await dismissNotificationByDosttId(dosttUserId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Game Routes ──────────────────────────────────────────────────────────────

const SPIN_ERROR_RESPONSES = {
  daily_limit_reached: { status: 429 }
};

function sendSpinResult(res, result) {
  if (result.status === 'error') {
    const mapping = SPIN_ERROR_RESPONSES[result.reason];
    if (mapping) {
      return res.status(mapping.status).json(result);
    }
  }
  return res.json(result);
}

app.post('/api/spin', async (req, res) => {
  try {
    const forcedReward = req.body.forcedReward || null;

    if (req.body.dosttUserId) {
      const dosttUserId = parseInt(req.body.dosttUserId, 10);
      if (!dosttUserId || dosttUserId <= 0) {
        return res.status(400).json({ error: 'Valid dosttUserId is required' });
      }
      const result = await spinForPlayerByDosttId(dosttUserId, forcedReward);
      return sendSpinResult(res, result);
    }

    const mobileNumber = cleanMobileNumber(req.body.mobileNumber);
    if (mobileNumber.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required' });
    }
    const result = await spinForPlayer(mobileNumber, forcedReward);
    return sendSpinResult(res, result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/transfers', async (req, res) => {
  try {
    const coinsRequested = Number(req.body.coinsRequested);

    if (req.body.dosttUserId) {
      const dosttUserId = parseInt(req.body.dosttUserId, 10);
      if (!dosttUserId || dosttUserId <= 0) {
        return res.status(400).json({ error: 'Valid dosttUserId is required' });
      }
      const transfer = await createTransferRequestByDosttId(dosttUserId, coinsRequested);
      if (transfer.status === 'failed_provider') {
        return res.status(502).json({
          error: transfer.public_error || 'We could not complete the transfer right now.',
          transfer
        });
      }
      return res.status(201).json(transfer);
    }

    const mobileNumber = cleanMobileNumber(req.body.mobileNumber);
    if (mobileNumber.length !== 10) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required' });
    }

    const transfer = await createTransferRequest(mobileNumber, coinsRequested);

    if (transfer.status === 'failed_not_registered') {
      return res.status(404).json({
        error: transfer.public_error || 'We could not verify your Dostt account with this mobile number.',
        transfer
      });
    }

    if (transfer.status === 'failed_provider') {
      return res.status(502).json({
        error: transfer.public_error || 'We could not complete the transfer right now.',
        transfer
      });
    }

    res.status(201).json(transfer);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

// ─── Admin Routes ────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const user = req.headers['x-admin-user'];
  const pass = req.headers['x-admin-pass'];
  if (user === process.env.ADMIN_USERNAME && pass === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const stats = await getAdminStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/ddr', requireAdmin, async (_req, res) => {
  try {
    res.json(await getDDRStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/ddr-series', requireAdmin, async (_req, res) => {
  try {
    res.json(await getDDRTimeSeries());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/cohort-retention', requireAdmin, async (req, res) => {
  try {
    const data = await getCohortRetention(req.query.date);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/data/:type', requireAdmin, async (req, res) => {
  try {
    const { type } = req.params;
    const filters = { status: req.query.status, date: req.query.date, mobile: req.query.mobile };
    const data = await getAdminTableData(type, filters);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/transfers/:id/retry', requireAdmin, async (req, res) => {
  try {
    const result = await retryTransfer(Number(req.params.id));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/retry-all', requireAdmin, async (req, res) => {
  try {
    const results = await retryAllFailed(req.body.mobile || null);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/reward-engine', requireAdmin, async (_req, res) => {
  try {
    res.json(await getRewardEngineReport());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// One player's plans: ?dosttUserId=123 or ?mobile=9876543210
app.get('/api/admin/reward-engine/player', requireAdmin, async (req, res) => {
  try {
    const dosttUserId = req.query.dosttUserId ? parseInt(req.query.dosttUserId, 10) : null;
    const mobileNumber = req.query.mobile ? normalizeMobile(req.query.mobile) : null;
    if (!dosttUserId && !mobileNumber) {
      return res.status(400).json({ error: 'dosttUserId or mobile is required' });
    }
    res.json(await getPlayerRewardPlans({ dosttUserId, mobileNumber }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/players/:mobileNumber/dismiss-notification', async (req, res) => {
  try {
    await dismissNotification(req.params.mobileNumber);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// serve admin panel — never cache HTML so versioned JS/CSS always loads fresh
app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/test/reset', async (req, res) => {
  try {
    const mobileNumber = cleanMobileNumber(req.body.mobileNumber);
    const result = await resetTestData(mobileNumber);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Global error handler — catches unhandled errors and alerts Slack
app.use((err, req, res, _next) => {
  const msg = `🚨 *Server error on spinwheel.dostt.in*\n*Route:* ${req.method} ${req.path}\n*Error:* ${err.message}`;
  console.error(msg);
  sendSlackAlert(msg);
  res.status(500).json({ error: err.message });
});

app.listen(port, () => {
  console.log(`Spin wheel backend running on http://localhost:${port}`);
  startRechargeGateScheduler();
  startRewardScoringScheduler();
});
