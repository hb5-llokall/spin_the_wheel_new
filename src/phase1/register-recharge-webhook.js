import { timingSafeEqual } from 'crypto';
import { recordRecharge } from './reward-engine.js';

// Phase-1 recharge webhook, not mounted. Call registerRechargeWebhook(app) to
// bring it back.
export function registerRechargeWebhook(app) {
  // ─── Internal: recharge events from Dostt ────────────────────────────────────
  // Dostt's payment system calls this on every successful recharge (and again
  // with refunded=true on a refund) so the reward engine can start paid cycles.

  function hasValidInternalKey(req) {
    const expected = process.env.RECHARGE_WEBHOOK_SECRET;
    const given = req.headers['x-internal-key'];
    if (!expected || typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  app.post('/api/internal/recharges', async (req, res) => {
    if (!process.env.RECHARGE_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'Recharge webhook is not configured' });
    }
    if (!hasValidInternalKey(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const dosttUserId = parseInt(req.body.dosttUserId, 10);
      const amountRupees = Number(req.body.amountRupees);
      const externalId = req.body.rechargeId != null ? String(req.body.rechargeId) : '';
      if (!dosttUserId || dosttUserId <= 0 || !externalId || !(amountRupees > 0)) {
        return res.status(400).json({ error: 'dosttUserId, rechargeId and a positive amountRupees are required' });
      }
      const result = await recordRecharge({
        dosttUserId,
        externalId,
        amountRupees,
        coins: req.body.coins != null ? Number(req.body.coins) : null,
        rechargedAt: req.body.rechargedAt || null,
        refunded: req.body.refunded === true,
        source: 'webhook'
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
