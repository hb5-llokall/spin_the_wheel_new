import dotenv from 'dotenv';

dotenv.config();

const REDASH_BASE_URL = process.env.REDASH_BASE_URL || 'https://analytics.getlokalapp.com';

async function redashFetch(path, options = {}, timeoutMs = 15000) {
  const apiKey = process.env.REDASH_API_KEY;
  if (!apiKey) {
    throw new Error('REDASH_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${REDASH_BASE_URL}${path}`, {
      ...options,
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Redash ${path} → HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Runs a Redash query and returns its result rows: trigger a fresh run
 * (max_age: 0), poll the job, then fetch the result JSON. Nothing is holding
 * an HTTP request open on this call, so it polls patiently, and a transient
 * poll error (e.g. a 502) is retried instead of failing the run. Unlike an
 * open-ended loop, it gives up after maxPolls so a sustained outage fails
 * loudly instead of spinning forever.
 */
export async function runRedashQuery(queryId, parameters = {}, {
  pollIntervalMs = 5000,
  maxPolls = 120,
  maxConsecutiveErrors = 5
} = {}) {
  if (!queryId) {
    throw new Error('Redash query id is required');
  }

  const data = await redashFetch(`/api/queries/${queryId}/results`, {
    method: 'POST',
    body: JSON.stringify({ parameters, max_age: 0 })
  });

  if (data.query_result) {
    return data.query_result.data.rows || [];
  }

  if (!data.job?.id) {
    throw new Error(`Redash returned neither query_result nor job: ${JSON.stringify(data).slice(0, 200)}`);
  }

  let consecutiveErrors = 0;
  for (let index = 0; index < maxPolls; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let jobData;
    try {
      jobData = await redashFetch(`/api/jobs/${data.job.id}`);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      console.warn(`Redash job ${data.job.id} poll error (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`);
      if (consecutiveErrors >= maxConsecutiveErrors) throw error;
      continue;
    }

    const status = jobData.job?.status;
    console.log(`Redash job ${data.job.id} poll ${index + 1}/${maxPolls} — status ${status}`);

    if (status === 3) {
      const final = await redashFetch(`/api/query_results/${jobData.job.query_result_id}.json`);
      return final.query_result.data.rows || [];
    }

    if (status === 4 || status === 5) {
      throw new Error(jobData.job?.error || `Redash job ${status === 5 ? 'cancelled' : 'failed'}`);
    }
  }

  throw new Error(`Redash job ${data.job.id} did not finish within ${(maxPolls * pollIntervalMs) / 1000}s`);
}
