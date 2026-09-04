/**
 * Widget core – init, verify, domain check, config, and postMessage.
 * Single global: Awoof
 */

import { checkDomain } from './api.js';
import { createModal } from './modal.js';

const AWOOF_MESSAGE_TYPE = 'AWOOF_VERIFICATION_SUCCESS';

let state = {
  apiBaseUrl: '',
  webAppUrl: '',
  apiKey: '',
  vendorId: null,
  domainAllowed: false,
  token: null,
  callbacks: { onSuccess: null, onError: null, onCancel: null },
  config: { theme: 'light', language: 'en', modalTitle: 'Verify Student Status' },
};

/**
 * Initialize the widget. Call once with your API key and backend URL.
 * Validates the current domain against the vendor allowlist.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - Vendor widget API key (from Awoof dashboard)
 * @param {string} [opts.apiBaseUrl] - Backend API base URL (e.g. https://api.awoof.com). Defaults to same origin if script is served from API.
 * @param {string} [opts.domain] - Override domain to check (default: window.location.hostname)
 * @param {string} [opts.webAppUrl] - Awoof web app URL for the verification iframe (e.g. https://app.awoof.com). Required for verify() to open the flow.
 * @param {(token: string, data?: object) => void} [opts.onSuccess]
 * @param {(error: Error) => void} [opts.onError]
 */
function init(opts = {}) {
  const apiKey = opts.apiKey || opts.api_key;
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('Awoof.init: apiKey is required');
  }

  state.apiKey = apiKey.trim();
  state.apiBaseUrl = (opts.apiBaseUrl || getDefaultApiBase()).replace(/\/$/, '');
  state.webAppUrl = (opts.webAppUrl || '').replace(/\/$/, '');
  state.callbacks.onSuccess = opts.onSuccess || null;
  state.callbacks.onError = opts.onError || null;
  state.callbacks.onCancel = opts.onCancel || null;
  if (opts.domain != null) state.domainOverride = opts.domain;

  return checkDomain(state.apiBaseUrl, getDomain(), state.apiKey)
    .then((result) => {
      state.domainAllowed = result.allowed;
      state.vendorId = result.vendorId || null;
      return { allowed: true, vendorId: state.vendorId };
    })
    .catch((err) => {
      state.domainAllowed = false;
      state.vendorId = null;
      throw err;
    });
}

function getDefaultApiBase() {
  if (typeof window === 'undefined' || !window.location) return '';
  const origin = window.location.origin;
  return origin;
}

function getDomain() {
  if (state.domainOverride != null) return String(state.domainOverride).trim();
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    return window.location.hostname;
  }
  return '';
}

/**
 * Open the verification modal. If domain was not allowed on init, shows error.
 * Otherwise shows the verification UI (currently a placeholder; full flow will redirect or embed verification).
 */
function verify(verifyOpts = {}) {
  const onSuccess = verifyOpts.onSuccess || state.callbacks.onSuccess;
  const onError = verifyOpts.onError || state.callbacks.onError;
  const onCancel = verifyOpts.onCancel || state.callbacks.onCancel;

  if (!state.apiKey) {
    const err = new Error('Awoof: not initialized. Call Awoof.init({ apiKey, ... }) first.');
    if (onError) onError(err);
    return Promise.reject(err);
  }

  if (!state.domainAllowed) {
    const err = new Error('This domain is not allowed to use the Awoof widget. Add it in your Awoof vendor dashboard.');
    const modal = createModal({
      title: state.config.modalTitle,
      error: err.message,
      onClose: () => onCancel && onCancel(),
    });
    modal.open();
    if (onError) onError(err);
    return Promise.reject(err);
  }

  if (!state.webAppUrl) {
    const err = new Error('Awoof widget: webAppUrl is required for verification. Pass it in Awoof.init({ webAppUrl: "https://app.awoof.com", ... }).');
    const modal = createModal({
      title: state.config.modalTitle,
      error: err.message,
      onClose: () => onCancel && onCancel(),
    });
    modal.open();
    if (onError) onError(err);
    return Promise.reject(err);
  }

  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const params = new URLSearchParams({
    apiKey: state.apiKey,
    vendorId: String(state.vendorId || ''),
    origin,
  });
  if (verifyOpts.vendorId) params.set('vendorId', String(verifyOpts.vendorId));
  if (verifyOpts.productId) params.set('productId', String(verifyOpts.productId));
  const iframeUrl = `${state.webAppUrl}/widget/verify?${params.toString()}`;

  const modal = createModal({
    title: state.config.modalTitle,
    message: 'Loading verification…',
    onClose: () => onCancel && onCancel(),
  });
  modal.open();
  const iframe = document.createElement('iframe');
  iframe.src = iframeUrl;
  iframe.title = 'Verify student';
  iframe.style.cssText = 'width:100%;height:400px;border:0;border-radius:8px;';
  modal.setNode(iframe);

  const expectedIframeOrigin = new URL(state.webAppUrl).origin;

  const handleMessage = (event) => {
    if (event.origin !== expectedIframeOrigin || event.source !== iframe.contentWindow) return;
    if (!event.data || event.data.type !== AWOOF_MESSAGE_TYPE) return;
    if (typeof event.data.token !== 'string' || !event.data.token.startsWith('awoof_')) return;
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('message', handleMessage);
    }
    modal.close();
    const { token, studentId, verifiedAt, method } = event.data;
    state.token = token;
    sendSuccessToParent(token, { studentId, verifiedAt, method });
  };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', handleMessage);
  }

  return Promise.resolve(undefined);
}

/**
 * Send verification success to the parent window (and to optional callback).
 * Called when the widget has obtained a token from the backend.
 */
function sendSuccessToParent(token, data = {}) {
  const payload = {
    type: AWOOF_MESSAGE_TYPE,
    token,
    studentId: data.studentId,
    verifiedAt: data.verifiedAt || new Date().toISOString(),
    method: data.method || 'widget',
  };
  if (typeof window !== 'undefined' && window.postMessage) {
    window.postMessage(payload, window.location.origin);
  }
  const cb = state.callbacks.onSuccess;
  if (cb) cb(token, data);
}

function config(opts = {}) {
  if (opts.theme != null) state.config.theme = opts.theme;
  if (opts.language != null) state.config.language = opts.language;
  if (opts.modalTitle != null) state.config.modalTitle = opts.modalTitle;
  return state.config;
}

function isVerified() {
  return !!state.token;
}

function getToken() {
  return state.token;
}

function clear() {
  state.token = null;
}

function checkDomainStatus() {
  if (!state.apiKey || !state.apiBaseUrl) return Promise.reject(new Error('Not initialized'));
  return checkDomain(state.apiBaseUrl, getDomain(), state.apiKey);
}

export default {
  init,
  verify,
  config,
  isVerified,
  getToken,
  clear,
  checkDomain: checkDomainStatus,
  _sendSuccessToParent: sendSuccessToParent,
  _getState: () => ({ ...state }),
};
