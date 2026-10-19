import dotenv from 'dotenv';
import { runQuery, runInTransaction } from './db.js';
import { runRedashQuery } from './redash-client.js';
import { isTesterMobile, normalizeMobile } from './spin-wheel-service.js';

dotenv.config();

const DAY_THRESHOLD = Number(process.env.RECHARGE_GATE_DAY_THRESHOLD || 5);

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Everyone who has crossed the threshold, plus everyone currently flagged so
// they can be cleared once they pay (drop off the Redash list).
async function findCandidates() {
  const { rows } = await runQuery(
    `
      SELECT p.id,
             p.mobile_number,
             p.dostt_user_id,
             p.must_recharge_to_spin,
             COALESCE(d.unique_days, 0) AS unique_days
      FROM players p
      LEFT JOIN (
        SELECT player_id, COUNT(DISTINCT spin_date)::int AS unique_days
        FROM spin_events
        GROUP BY player_id
      ) d ON d.player_id = p.id
      WHERE COALESCE(d.unique_days, 0) >= $1
         OR p.must_recharge_to_spin = TRUE
    `,
    [DAY_THRESHOLD]
  );
  return rows;
}

// The Redash query takes no parameters: it returns every user who is still
// unpaid since the spin launch and has transferred at least once, as rows
// with `user_id` and/or `mobile_no`.
async function fetchUnpaidList() {
  const queryId = process.env.REDASH_ELIGIBILITY_QUERY_ID;
  if (!queryId) {
    throw new Error('REDASH_ELIGIBILITY_QUERY_ID is not configured — refusing to run the recharge gate job');
  }

  const rows = await runRedashQuery(queryId);

  // Fail-safe: this list should never be empty in practice, so an empty
  // result is much more likely a broken query than "everyone paid."
  if (rows.length === 0) {
    throw new Error('Redash returned 0 unpaid users — this looks like a broken query. Aborting without writing any changes.');
  }

  // A wrong query id would otherwise match nobody and silently clear every flag.
  const columns = Object.keys(rows[0]);
  if (!columns.includes('user_id') && !columns.includes('mobile_no')) {
    throw new Error(`Redash query ${queryId} has no user_id or mobile_no column (got: ${columns.join(', ')}) — wrong query? Aborting without writing any changes.`);
  }

  return {
    size: rows.length,
    byMobile: new Set(rows.map((row) => row.mobile_no).filter(Boolean).map(normalizeMobile)),
    byDosttId: new Set(rows.map((row) => row.user_id).filter((v) => v != null).map(Number))
  };
}

function decide(candidate, unpaid) {
  if (candidate.mobile_number && isTesterMobile(candidate.mobile_number)) {
    return { flag: false, reason: 'tester' };
  }
  if (candidate.unique_days < DAY_THRESHOLD) {
    return { flag: false, reason: 'below_threshold' };
  }
  const isUnpaid =
    (candidate.mobile_number && unpaid.byMobile.has(normalizeMobile(candidate.mobile_number))) ||
    (candidate.dostt_user_id != null && unpaid.byDosttId.has(Number(candidate.dostt_user_id)));
  return isUnpaid ? { flag: true, reason: 'unpaid_5_days' } : { flag: false, reason: 'paid' };
}

async function writeDecisions(decisions) {
  await runInTransaction(async (client) => {
    for (const batch of chunk(decisions, 1000)) {
      await client.query(
        `
          UPDATE players p
          SET must_recharge_to_spin    = u.flag,
              recharge_gate_checked_at = NOW()
          FROM (
            SELECT unnest($1::bigint[])  AS id,
                   unnest($2::boolean[]) AS flag
          ) u
          WHERE p.id = u.id
        `,
        [batch.map((d) => d.id), batch.map((d) => d.flag)]
      );
    }
  });
}

async function recordRun({ status, dryRun, summary = null, error = null }) {
  try {
    await runQuery(
      'INSERT INTO recharge_gate_runs (status, dry_run, summary, error) VALUES ($1, $2, $3, $4)',
      [status, dryRun, summary ? JSON.stringify(summary) : null, error]
    );
  } catch (recordError) {
    console.error('Failed to record recharge gate run:', recordError.message);
  }
}

export async function getLastSuccessfulRunAt() {
  const { rows } = await runQuery(
    "SELECT MAX(ran_at) AS ran_at FROM recharge_gate_runs WHERE status = 'success' AND dry_run = FALSE"
  );
  return rows[0]?.ran_at || null;
}

export async function runRechargeGateJob({ dryRun = false } = {}) {
  try {
    const unpaid = await fetchUnpaidList();
    const candidates = await findCandidates();

    const decisions = candidates.map((candidate) => ({
      id: candidate.id,
      current: candidate.must_recharge_to_spin,
      ...decide(candidate, unpaid)
    }));

    const summary = {
      redashUnpaidUsers: unpaid.size,
      candidates: candidates.length,
      testers: decisions.filter((d) => d.reason === 'tester').length,
      belowThreshold: decisions.filter((d) => d.reason === 'below_threshold').length,
      flagged: decisions.filter((d) => d.flag).length,
      newlyFlagged: decisions.filter((d) => d.flag && !d.current).length,
      cleared: decisions.filter((d) => d.current && !d.flag).length
    };

    if (!dryRun && decisions.length > 0) {
      await writeDecisions(decisions);
    }

    await recordRun({ status: 'success', dryRun, summary });

    return summary;
  } catch (error) {
    await recordRun({ status: 'failed', dryRun, error: error.message });
    throw error;
  }
}
