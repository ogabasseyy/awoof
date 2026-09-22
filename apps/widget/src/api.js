/**
 * API client for widget – domain check and (later) token.
 * All requests go to the Awoof backend API.
 */

/**
 * @param {string} apiBaseUrl - e.g. https://api.awoof.com
 * @param {string} domain - current hostname
 * @param {string} apiKey - vendor widget API key
 * @returns {Promise<{ allowed: boolean, vendorId?: string }>}
 */
export async function checkDomain(apiBaseUrl, domain, apiKey) {
  const url = new URL('/api/widget/domain-check', apiBaseUrl);

  // POST with a JSON body: the API key must never travel in the URL, where
  // it would land in access logs, proxy/CDN logs, history, and Referers.
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain, apiKey }),
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
}
