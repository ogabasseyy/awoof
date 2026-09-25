/** Browser handoff for the controlled merchant eligibility pilot. */
import { checkDomain } from './api.js';

const MESSAGE_TYPE = 'AWOOF_ELIGIBILITY_CODE';
const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
let state = {
  apiBaseUrl: '', webAppUrl: '', apiKey: '', vendorId: null, originAllowed: false,
  callbacks: { onSuccess: null, onError: null, onCancel: null },
};
let active = false;

function secureOrigin(value, description) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${description} must be an absolute HTTPS origin`); }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${description} must be an absolute HTTPS origin (localhost HTTP is allowed for development)`);
  }
  return url.origin;
}

/** Public widget key identifies a merchant site. The private exchange key stays on the merchant server. */
function init(opts = {}) {
  if (active) throw new Error('Awoof.init: verification is already open');
  const apiKey = opts.apiKey || opts.api_key;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Awoof.init: apiKey is required');
  if (typeof window === 'undefined') throw new Error('Awoof.init: browser required');
  const apiBaseUrl = secureOrigin(opts.apiBaseUrl || window.location.origin, 'apiBaseUrl');
  const webAppUrl = secureOrigin(opts.webAppUrl, 'webAppUrl');
  const origin = secureOrigin(window.location.origin, 'merchant origin');
  state = {
    apiBaseUrl, webAppUrl, apiKey: apiKey.trim(), vendorId: null, originAllowed: false,
    callbacks: { onSuccess: opts.onSuccess || null, onError: opts.onError || null, onCancel: opts.onCancel || null },
  };
  return checkDomain(apiBaseUrl, window.location.hostname, state.apiKey, origin).then((result) => {
    if (!result.allowed || typeof result.vendorId !== 'string') throw new Error('Merchant origin is not approved');
    state.vendorId = result.vendorId;
    state.originAllowed = true;
    return { allowed: true, vendorId: result.vendorId };
  }).catch((error) => { state.vendorId = null; state.originAllowed = false; throw error; });
}

/**
 * Call from a click handler. The promise resolves with {code, campaignId, expiresAt}.
 * Send the code to your own server, which exchanges it using its private key.
 */
function verify(opts = {}) {
  const onSuccess = opts.onSuccess || state.callbacks.onSuccess;
  const onError = opts.onError || state.callbacks.onError;
  const onCancel = opts.onCancel || state.callbacks.onCancel;
  const campaignId = typeof opts.campaignId === 'string' ? opts.campaignId.trim() : '';
  const purpose = typeof opts.purpose === 'string' ? opts.purpose.trim() : '';
  const fail = (message) => {
    const error = new Error(message);
    if (onError) onError(error);
    return Promise.reject(error);
  };
  if (!state.originAllowed || !state.vendorId) return fail('Awoof.init must approve this exact merchant origin before verification');
  if (active) return fail('Awoof verification is already open');
  if (!campaignId || campaignId.length > 100 || !purpose || purpose.length > 200) {
    return fail('Awoof.verify requires a campaignId and a purpose');
  }
  if (!window.crypto?.getRandomValues) return fail('Secure browser randomness is required');
  const nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
  const origin = window.location.origin;
  const expectedWebAppOrigin = state.webAppUrl;
  const query = new URLSearchParams({ vendorId: state.vendorId, origin, campaignId, purpose, state: nonce });
  const popup = window.open(`${expectedWebAppOrigin}/widget/verify?${query}`, '_blank', 'width=520,height=680');
  if (!popup) return fail('The verification window was blocked. Allow popups and try again');
  active = true;
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { window.removeEventListener('message', receive); clearInterval(closed); clearTimeout(timeout); active = false; };
    const settle = (outcome, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!popup.closed) popup.close();
      if (outcome === 'success') { resolve(value); if (onSuccess) onSuccess(value.code, value); }
      else { reject(value); if (outcome === 'cancel') { if (onCancel) onCancel(); } else if (onError) onError(value); }
    };
    const receive = (event) => {
      if (event.origin !== expectedWebAppOrigin || event.source !== popup) return;
      const value = event.data;
      if (!value || value.type !== MESSAGE_TYPE || value.state !== nonce || value.campaignId !== campaignId) return;
      const expiry = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
      // Browser clocks can be fast or slow; the merchant's server exchange checks expiry.
      if (!CODE.test(value.code) || !Number.isFinite(expiry)) return;
      settle('success', { code: value.code, campaignId, expiresAt: value.expiresAt });
    };
    window.addEventListener('message', receive);
    const closed = setInterval(() => { if (popup.closed) settle('cancel', new Error('Verification window closed or its opener was isolated. Cross-Origin-Opener-Policy: same-origin on the merchant page is incompatible with this popup.')); }, 500);
    const timeout = setTimeout(() => settle('error', new Error('Verification timed out')), 10 * 60 * 1000);
  });
}

export default { init, verify, checkDomain: () => checkDomain(state.apiBaseUrl, window.location.hostname, state.apiKey, window.location.origin) };
