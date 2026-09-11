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
  url.searchParams.set('domain', domain);
  url.searchParams.set('apiKey', apiKey);

  const res = await fetch(url.toString(), { method: 'GET' });
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
