// A generic retry wrapper for any async function that might hit a rate limit.
// We use it here for Gemini calls, but it's written generically so it could
// wrap the Linear/Deepgram calls too if we ever need to.

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry(fn, { maxRetries = 5, baseDelayMs = 2000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Only retry on rate limit errors (429) - other errors (bad request,
      // auth failure) won't be fixed by waiting, so we fail fast on those.
      const isRateLimit = err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED');

      if (!isRateLimit || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s - each retry waits longer,
      // giving the rate limit window time to actually reset instead of
      // hammering it again immediately.
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// A simple fixed delay, used to space out calls proactively in the eval
// script rather than only reacting after hitting a limit.
export { sleep };