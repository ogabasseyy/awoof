/**
 * Public widget-key client for exact merchant origin approval.
 * All requests go to the Awoof backend API.
 */

/** Default bound for a merchant approval request. A stalled request must fail so init can retry. */
export const DOMAIN_CHECK_TIMEOUT_MS = 15000;

/**
 * @param {string} apiBaseUrl - e.g. https://api.awoof.com
 * @param {string} domain - current hostname
 * @param {string} apiKey - vendor widget API key
 * @param {string} origin - exact current merchant origin
 * @param {{ timeoutMs?: number }} [options] - approval bound; defaults to DOMAIN_CHECK_TIMEOUT_MS
 * @returns {Promise<{ allowed: boolean, vendorId?: string }>}
 */
export async function checkDomain(apiBaseUrl, domain, apiKey, origin, options = {}) {
  const url = new URL('/api/widget/domain-check', apiBaseUrl);
  const timeoutMs = options.timeoutMs ?? DOMAIN_CHECK_TIMEOUT_MS;

  // POST with a JSON body: the API key must never travel in the URL, where
  // it would land in access logs, proxy/CDN logs, history, and Referers.
  // The abort bound keeps a stalled connection from locking out retries:
  // without it, init's in-progress guard would never release.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, apiKey, origin }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = body?.error?.message || body?.message || res.statusText;
      throw new Error(msg || 'Domain check failed');
    }

    return {
      allowed: body?.data?.allowed === true,
      vendorId: body?.data?.vendorId,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Merchant approval timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
