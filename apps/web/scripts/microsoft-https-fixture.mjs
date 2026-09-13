#!/usr/bin/env node
/**
 * Disposable HTTPS transport for the Microsoft browser contract.
 *
 * This is deliberately separate from the normal HTTP browser fixture.  It
 * reverse-proxies the local Next dev server only and implements a tiny,
 * synthetic API.  It never resolves or contacts a Microsoft tenant.  The
 * Playwright spec intercepts the one allowed Microsoft document navigation
 * and fulfils it locally; every other provider request is aborted there.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nextPort = 3107;
const appPort = 3443;
const apiPort = 3444;
const apiUpstreamPort = 3445;
const fixtureDir = mkdtempSync(join(tmpdir(), 'awoof-microsoft-https-'));
const keyPath = join(fixtureDir, 'key.pem');
const certPath = join(fixtureDir, 'cert.pem');
// The fixture starts with only non-secret test values and changes its cwd to a
// fresh directory before importing backend modules, so their dotenv lookup
// cannot read a workspace .env file. Next receives its own similarly bounded
// environment below.
const fixturePath = process.env.PATH ?? '';
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  PATH: fixturePath,
  NODE_ENV: 'test',
  JWT_SECRET: 'fixture-jwt-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'fixture-refresh-secret-at-least-32-characters',
});
process.chdir(fixtureDir);
const { default: express } = await import('../../backend/node_modules/express/index.js');
const { logger } = await import('../../backend/src/common/middleware/logger.ts');
const { errorHandler } = await import('../../backend/src/common/middleware/errorHandler.ts');
const { verificationDiagnosticsErrorHandler } = await import('../../backend/src/middleware/verification-diagnostics-error.middleware.ts');
let next;
let closed = false;
let startCalls = 0;
let callbackCookieCalls = 0;
let finishCalls = 0;
let refreshCalls = 0;
let logoutCalls = 0;
let delayedFinishDeliveries = 0;
let diagnosticCalls = 0;
let diagnosticsUnavailableReleased = false;
const attempts = new Map();
const observedPaths = [];
const observedServerSessions = [];
const capturedApplicationLogs = [];
const capturedApplicationErrors = [];
const capturedProxyLogs = [];
const delayedFinishResponses = new Set();
const delayedDiagnosticResponses = new Set();
const noticeChanges = new Set();
const acceptedConsentSnapshots = [];
const revokedServerSessions = new Set();
const appSockets = new Set();

function initialAccounts() {
  return new Map([
    ['00000000-0000-4000-8000-000000000001', { email: 'student-a@approved.test', emailEvidenceEligible: true, microsoftEnrollmentEligible: false, finishCalls: 0, linkedMicrosoftIdentities: 0 }],
    ['00000000-0000-4000-8000-000000000002', { email: 'student-b@approved.test', emailEvidenceEligible: false, microsoftEnrollmentEligible: false, finishCalls: 0, linkedMicrosoftIdentities: 0 }],
  ]);
}
let accounts = initialAccounts();

function resetFixture() {
  startCalls = 0; callbackCookieCalls = 0; finishCalls = 0; refreshCalls = 0; logoutCalls = 0; delayedFinishDeliveries = 0; diagnosticCalls = 0; diagnosticsUnavailableReleased = false;
  attempts.clear(); noticeChanges.clear(); acceptedConsentSnapshots.length = 0; revokedServerSessions.clear(); observedPaths.length = 0; observedServerSessions.length = 0;
  capturedApplicationLogs.length = 0; capturedApplicationErrors.length = 0; capturedProxyLogs.length = 0;
  for (const release of delayedFinishResponses) release(true);
  delayedFinishResponses.clear(); accounts = initialAccounts();
  for (const release of delayedDiagnosticResponses) release();
  delayedDiagnosticResponses.clear();
}

const originalConsoleLog = console.log;
console.log = (...args) => { capturedApplicationLogs.push(args.map(String).join(' ')); };
console.error = (...args) => { capturedApplicationErrors.push(args.map(String).join(' ')); };

function trackSocket(socket) {
  appSockets.add(socket);
  socket.on('close', () => appSockets.delete(socket));
  // A peer may disappear while the other half of an upgraded tunnel closes.
  // Handle that expected fixture teardown condition instead of leaking it as
  // an unhandled ECONNRESET.
  socket.on('error', () => {});
}

// This test-only leaf is intentionally untrusted. Chrome receives its
// per-process exception from playwright.microsoft.config.ts; no keychain,
// host file, or system trust store is modified.
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', keyPath, '-out', certPath,
  '-subj', '/CN=awoof.test',
  '-addext', 'subjectAltName=DNS:app.awoof.test,DNS:api.awoof.test',
], { stdio: 'ignore' });
const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

function cors(request, response) {
  const origin = request?.headers?.origin;
  if (origin === `https://app.awoof.test:${appPort}`) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function json(request, response, status, payload, headers = {}) {
  cors(request, response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function authContext(request) {
  const token = request.headers.authorization ?? '';
  if (token.startsWith('Bearer admin-access')) {
    const modes = new Set(token.slice('Bearer admin-access'.length).split(':').filter(Boolean));
    const id = modes.has('admin-b') ? '00000000-0000-4000-8000-000000000099' : '00000000-0000-4000-8000-000000000098';
    return {
      id, modes, serverSessionId: modes.has('admin-b') ? 'fixture-admin-session-b' : 'fixture-admin-session-a',
      user: { id, email: modes.has('admin-b') ? 'admin-b@approved.test' : 'admin@approved.test', role: 'admin' },
    };
  }
  if (!token.startsWith('Bearer student-access')) return null;
  const modes = new Set(token.slice('Bearer student-access'.length).split(':').filter(Boolean));
  const id = modes.has('account-b')
    ? '00000000-0000-4000-8000-000000000002'
    : '00000000-0000-4000-8000-000000000001';
  return {
    id, modes,
    serverSessionId: id === '00000000-0000-4000-8000-000000000002'
      ? (modes.has('relogin') ? 'fixture-server-session-b-relogin' : 'fixture-server-session-b')
      : (modes.has('relogin') ? 'fixture-server-session-a-relogin' : 'fixture-server-session-a'),
    user: { id, email: accounts.get(id).email, role: 'student', verificationStatus: 'unverified' },
  };
}

function hasMode(context, mode) {
  return Boolean(context?.modes.has(mode));
}

function body(request) {
  return new Promise((resolve) => {
    let value = '';
    request.on('data', (chunk) => { value += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(value || '{}')); } catch { resolve({}); }
    });
  });
}

async function throwCanaryThroughDiagnosticBoundary(request) {
  const url = new URL(request.url ?? '/', `https://api.awoof.test:${apiPort}`);
  const payload = await body(request);
  throw new Error([
    request.headers.authorization,
    request.headers.cookie,
    url.search,
    JSON.stringify(payload),
  ].join('|'));
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url ?? '/', `https://api.awoof.test:${apiPort}`);
  observedPaths.push(`${request.method} ${url.pathname}`);
  if (request.method === 'OPTIONS') { cors(request, response); response.writeHead(204); response.end(); return; }
  if (url.pathname === '/api/__fixture/reset' && request.method === 'POST') {
    resetFixture(); json(request, response, 204, {}); return;
  }
  if (url.pathname === '/api/__fixture/release-delayed-finish' && request.method === 'POST') {
    for (const delayed of delayedFinishResponses) delayed();
    delayedFinishResponses.clear(); json(request, response, 204, {}); return;
  }
  if (url.pathname === '/api/__fixture/release-delayed-diagnostics' && request.method === 'POST') {
    for (const delayed of delayedDiagnosticResponses) delayed();
    delayedDiagnosticResponses.clear(); json(request, response, 204, {}); return;
  }
  if (url.pathname === '/api/__fixture/release-diagnostics-unavailable' && request.method === 'POST') {
    diagnosticsUnavailableReleased = true; json(request, response, 204, {}); return;
  }
  if (url.pathname === '/api/__fixture/canary-mask' && request.method === 'POST') {
    await throwCanaryThroughDiagnosticBoundary(request);
  }
  if (url.pathname === '/api/__fixture/evidence') {
    json(request, response, 200, { data: {
      startCalls, finishCalls, callbackCookieCalls, refreshCalls, logoutCalls, delayedFinishDeliveries, observedPaths, observedServerSessions,
      diagnosticCalls, capturedApplicationLogs, capturedApplicationErrors, capturedProxyLogs,
      acceptedConsentSnapshots, revokedServerSessions: [...revokedServerSessions],
      accounts: Object.fromEntries([...accounts].map(([id, account]) => [id, {
        emailEvidenceEligible: account.emailEvidenceEligible,
        microsoftEnrollmentEligible: account.microsoftEnrollmentEligible,
        finishCalls: account.finishCalls,
        linkedMicrosoftIdentities: account.linkedMicrosoftIdentities,
      }])),
      attempts: [...attempts.values()].map(({ attemptId, ownerId, ready, callbackUsed, completed, callbackCookieCalls: attemptCallbackCookieCalls, finishCalls: attemptFinishCalls, finishCookieCalls, completionWrites, callbackOutcome, transientFailures }) => ({
        attemptId, ownerId, ready, callbackUsed, completed, callbackCookieCalls: attemptCallbackCookieCalls, finishCalls: attemptFinishCalls, finishCookieCalls, completionWrites, callbackOutcome: callbackOutcome ?? null, transientFailures,
      })),
    } }); return;
  }
  const context = authContext(request);
  const user = context?.user ?? null;
  if (context) observedServerSessions.push({ path: url.pathname, serverSessionId: context.serverSessionId, userId: context.id });
  if (url.pathname === '/api/auth/me') {
    json(request, response, user ? 200 : 401, user ? { success: true, data: user } : { success: false }); return;
  }
  if (url.pathname === '/api/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20') {
    if (!context || context.user.role !== 'admin') { json(request, response, 403, { error: { code: 'fixture_admin_required' } }); return; }
    diagnosticCalls += 1;
    const send = () => {
      if (hasMode(context, 'not-found') || hasMode(context, 'admin-b')) {
        json(request, response, 404, { error: { code: 'fixture_diagnostic_not_found' } }); return;
      }
      if (hasMode(context, 'unavailable') && !diagnosticsUnavailableReleased) {
        json(request, response, 503, { error: { code: 'fixture_diagnostic_unavailable' } }); return;
      }
      json(request, response, 200, { success: true, data: {
        timeline: hasMode(context, 'empty-diagnostics') ? [] : [
          { stage: 'started', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 2, recordedAt: '2026-09-13T09:00:00.000Z' },
          { stage: 'finished', outcome: 'failure', reason: 'permission_required', httpStatus: 403, durationMs: 18, recordedAt: '2026-09-13T09:01:00.000Z' },
        ],
        aggregateWindow: 'last_30_days', measuredAt: '2026-09-13T10:00:00.000Z', windowStartedAt: '2026-08-14T10:00:00.000Z',
        aggregates: hasMode(context, 'empty-diagnostics') ? [] : [{ institutionId: 'fixture-institution', institutionName: 'Synthetic approved institution', finishedAttemptCount: 1, averageFinishedRequestDurationMs: 18, p95FinishedRequestDurationMs: 18, incompleteAttempts: 1, failureCategories: [{ category: 'permission_required', eventCount: 1 }] }],
      } });
    };
    if (hasMode(context, 'delay-diagnostics')) { delayedDiagnosticResponses.add(send); return; }
    send(); return;
  }
  if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
    refreshCalls += 1;
    const refresh = await body(request);
    if (refresh.refreshToken === 'student-refresh-refresh') {
      json(request, response, 200, { data: { accessToken: 'student-access:refresh-fresh', refreshToken: 'student-refresh-fresh' } }); return;
    }
    json(request, response, 401, { error: { code: 'fixture_refresh_rejected' } }); return;
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    if (!context) { json(request, response, 401, { error: { code: 'fixture_auth_required' } }); return; }
    logoutCalls += 1; revokedServerSessions.add(context.serverSessionId);
    json(request, response, 204, {}); return;
  }
  if (url.pathname === '/api/verification/status') {
    const account = user ? accounts.get(user.id) : null;
    const statusFailure = hasMode(context, 'status-failure') && Boolean(account?.finishCalls);
    const refreshExpired = hasMode(context, 'refresh-expired');
    if (refreshExpired) { json(request, response, 401, { error: { code: 'fixture_access_expired' } }); return; }
    json(request, response, statusFailure ? 503 : 200, statusFailure ? { error: { code: 'fixture_status_failure' } } : {
      success: true, data: {
        emailDomainApproved: true, mailboxConfirmed: Boolean(account?.emailEvidenceEligible), email: user?.email ?? 'unknown@approved.test', universityId: 'fixture-university',
        // Identity linking is deliberately not enrollment verification. The
        // fixture reports separate evidence sources, and only the account's
        // independent email evidence determines effective eligibility.
        eligibility: { eligible: Boolean(account?.emailEvidenceEligible || account?.microsoftEnrollmentEligible), emailEvidenceEligible: Boolean(account?.emailEvidenceEligible), microsoftIdentityLinked: Boolean(account?.linkedMicrosoftIdentities) }, notices: { verification: { version: 'fixture-v1', text: 'Synthetic Awoof processing notice.' } },
      },
    }); return;
  }
  if (url.pathname === '/api/verification/methods/fixture-university') {
    json(request, response, 200, { data: { methods: [
      { methodType: 'email', isAvailable: true }, { methodType: 'microsoft', isAvailable: !hasMode(context, 'global-off'), reason: hasMode(context, 'global-off') ? 'Microsoft connections are temporarily unavailable.' : undefined },
    ] } }); return;
  }
  if (url.pathname === '/api/verification/consents') { json(request, response, 200, { data: { items: [], nextCursor: null } }); return; }
  if (url.pathname === '/api/verification/initiate' && request.method === 'POST') { json(request, response, 200, { data: { processingGrantId: 'fixture-processing-grant' } }); return; }
  if (url.pathname === '/api/verification/microsoft/notice') {
    if (hasMode(context, 'notice-failure')) { json(request, response, 503, { error: { code: 'fixture_notice_unavailable' } }); return; }
    const changed = hasMode(context, 'notice-changed') && noticeChanges.has(context.id);
    const graph = hasMode(context, 'graph-enrollment');
    json(request, response, 200, { data: { snapshot: { universityId: 'fixture-university', providerPolicyVersion: changed ? 2 : 1, noticeVersion: changed ? 'fixture-provider-v2' : 'fixture-provider-v1', mode: graph ? 'graph_enrollment' : 'identity_only', scopes: graph ? ['openid', 'https://graph.microsoft.com/EduRoster.ReadBasic'] : ['openid'] }, copy: { text: changed ? 'Updated synthetic provider consent. Please accept this new notice.' : 'Synthetic provider consent for this isolated browser test.' } } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'GET') {
    const paginated = hasMode(context, 'history-pagination');
    const history = hasMode(context, 'global-off') || hasMode(context, 'notice-failure') || paginated
      ? [{ id: 'fixture-history-1', snapshot: { universityId: 'fixture-university', providerPolicyVersion: 1, noticeVersion: 'fixture-provider-v1', mode: 'identity_only', scopes: ['openid'] }, acceptedAt: '2026-09-01T00:00:00.000Z', withdrawnAt: null }]
      : [];
    const second = [{ id: 'fixture-history-2', snapshot: { universityId: 'fixture-university', providerPolicyVersion: 1, noticeVersion: 'fixture-provider-v1', mode: 'identity_only', scopes: ['openid'] }, acceptedAt: '2026-09-02T00:00:00.000Z', withdrawnAt: '2026-09-03T00:00:00.000Z' }];
    json(request, response, 200, { data: { items: paginated && url.searchParams.get('cursor') === 'fixture-history-page-2' ? second : history, nextCursor: paginated && url.searchParams.get('cursor') !== 'fixture-history-page-2' ? 'fixture-history-page-2' : null } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'POST') {
    const consentBody = await body(request);
    acceptedConsentSnapshots.push(consentBody.snapshot ?? null);
    if (hasMode(context, 'notice-changed') && !noticeChanges.has(context.id)) {
      noticeChanges.add(context.id); json(request, response, 409, { error: { code: 'consent_notice_changed' } }); return;
    }
    json(request, response, 200, { data: { providerConsentId: 'fixture-provider-consent' } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/start' && request.method === 'POST') {
    await body(request);
    if (!user) { json(request, response, 401, { error: { code: 'fixture_auth_required' } }); return; }
    const attemptId = `fixture-attempt-${++startCalls}`;
    const state = `fixture-state-${attemptId}`;
    attempts.set(state, { attemptId, ownerId: user.id, mode: [...context.modes], serverSessionId: context.serverSessionId, ready: false, callbackUsed: false, completed: false, callbackCookieCalls: 0, finishCalls: 0, finishCookieCalls: 0, completionWrites: 0, transientFailures: 0 });
    // Host-only, Secure, HttpOnly and Lax: the finish endpoint rejects a
    // request unless the browser returns this real response cookie.
    json(request, response, 200, { data: {
      attemptId, finishSecret: `fixture-finish-${attemptId}`,
      authorizationUrl: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${encodeURIComponent(state)}`,
    } }, { 'set-cookie': `__Host-awoof-microsoft-fixture=${attemptId}; Path=/; Secure; HttpOnly; SameSite=Lax` }); return;
  }
  if (url.pathname === '/api/verification/microsoft/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const attempt = attempts.get(state);
    const expected = attempt ? `__Host-awoof-microsoft-fixture=${attempt.attemptId}` : '';
    const hasCallbackCookie = Boolean(expected) && String(request.headers.cookie ?? '').split('; ').includes(expected);
    const callbackAccepted = Boolean(attempt) && hasCallbackCookie && !attempt.callbackUsed;
    const terminalProviderFailure = callbackAccepted && url.searchParams.has('error');
    if (callbackAccepted) {
      callbackCookieCalls += 1;
      attempt.callbackCookieCalls += 1;
      attempt.callbackUsed = true;
      if (terminalProviderFailure) attempt.callbackOutcome = 'connection_not_completed';
      else attempt.ready = true;
    }
    // The callback consumes the cookie before returning to the app. Finish is
    // intentionally authorized by the stored attempt/secret, never a cookie
    // that survived this redirect.
    const callbackHeaders = { 'set-cookie': '__Host-awoof-microsoft-fixture=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax' };
    if (callbackAccepted) {
      const completion = new URL(`https://app.awoof.test:${appPort}/student/verification/microsoft/complete`);
      completion.searchParams.set('attempt', attempt.attemptId);
      if (terminalProviderFailure) completion.searchParams.set('outcome', 'connection_not_completed');
      response.writeHead(303, { ...callbackHeaders, location: completion.href });
    } else {
      response.writeHead(400, callbackHeaders);
    }
    response.end(); return;
  }
  if (url.pathname === '/api/verification/microsoft/finish' && request.method === 'POST') {
    const requestBody = await body(request);
    finishCalls += 1;
    const attempt = [...attempts.values()].find((item) => item.attemptId === requestBody?.attemptId);
    if (attempt) {
      attempt.finishCalls += 1;
      if (String(request.headers.cookie ?? '').includes(`__Host-awoof-microsoft-fixture=${attempt.attemptId}`)) attempt.finishCookieCalls += 1;
    }
    if (user) accounts.get(user.id).finishCalls += 1;
    if (!attempt?.ready || requestBody?.finishSecret !== `fixture-finish-${attempt.attemptId}` || !user || attempt.ownerId !== user.id) {
      json(request, response, 401, { error: { code: 'fixture_finish_not_ready' } }); return;
    }
    if (attempt.serverSessionId !== context.serverSessionId || revokedServerSessions.has(context.serverSessionId)) {
      json(request, response, 401, { error: { code: 'fixture_finish_session_replaced' } }); return;
    }
    if (hasMode(context, 'terminal')) { json(request, response, 400, { error: { code: 'fixture_terminal_finish' } }); return; }
    if (hasMode(context, 'transient') && attempt.transientFailures === 0) {
      attempt.transientFailures += 1; json(request, response, 503, { error: { code: 'fixture_transient_finish' } }); return;
    }
    if (hasMode(context, 'delay-finish')) {
      delayedFinishResponses.add((cancelled = false) => {
        if (response.writableEnded) return;
        if (cancelled) { json(request, response, 503, { error: { code: 'fixture_delay_cancelled' } }); return; }
        delayedFinishDeliveries += 1;
        finishAttempt(request, response, attempt, user.id);
      });
      return;
    }
    finishAttempt(request, response, attempt, user.id);
    return;
  }
  json(request, response, 404, { error: { code: 'fixture_unknown_route', path: url.pathname } });
}

function finishAttempt(request, response, attempt, userId) {
  const graphEnrollment = attempt.mode?.includes('graph-enrollment') === true;
  if (attempt.completed) {
    json(request, response, 200, { data: { accountLinked: true, enrollment: graphEnrollment ? 'eligible' : 'not_checked' } }); return;
  }
  attempt.completed = true;
  attempt.completionWrites += 1;
  const account = accounts.get(userId);
  account.linkedMicrosoftIdentities += 1;
  if (graphEnrollment) account.microsoftEnrollmentEligible = true;
  json(request, response, 200, { data: { accountLinked: true, enrollment: graphEnrollment ? 'eligible' : 'not_checked' } });
}

const apiApplication = express();
apiApplication.use((request, response, nextMiddleware) => { cors(request, response); nextMiddleware(); });
apiApplication.use(logger);
const diagnosticsBoundary = express.Router();
diagnosticsBoundary.post('/api/__fixture/canary-mask', (request, _response, nextMiddleware) => {
  observedPaths.push(`${request.method} ${request.path}`);
  void throwCanaryThroughDiagnosticBoundary(request).catch(nextMiddleware);
});
diagnosticsBoundary.use(verificationDiagnosticsErrorHandler);
apiApplication.use(diagnosticsBoundary);
apiApplication.use((request, response, nextMiddleware) => {
  void handleApiRequest(request, response).catch(nextMiddleware);
});
apiApplication.use(errorHandler);

// The browser connects only to this TLS loopback proxy. It forwards into the
// local Express application and records its own post-upstream output, so the
// proxy and application captures are independently exercised rather than two
// copies of a synthetic formatter.
const apiUpstream = createHttpServer(apiApplication);
const api = createHttpsServer(tls, (request, response) => {
  const url = new URL(request.url ?? '/', `https://api.awoof.test:${apiPort}`);
  const upstream = httpRequest({ hostname: '127.0.0.1', port: apiUpstreamPort, path: request.url, method: request.method, headers: request.headers }, (upstreamResponse) => {
    const statusCode = upstreamResponse.statusCode ?? 502;
    response.writeHead(statusCode, upstreamResponse.headers);
    upstreamResponse.on('end', () => {
      if (statusCode >= 400) capturedProxyLogs.push(`${request.method} ${url.pathname} ${statusCode}`);
    });
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    capturedProxyLogs.push(`${request.method} ${url.pathname} 502`);
    cors(request, response);
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ success: false, error: { message: 'Synthetic fixture upstream unavailable', code: 'fixture_upstream_unavailable', statusCode: 502 } }));
  });
  request.pipe(upstream);
});

const app = createHttpsServer(tls, (request, response) => {
  // Preserve the browser Host header. Next uses it when it emits its dev
  // runtime URLs; changing it to the loopback upstream strands hydration on
  // the server-rendered Loading shell.
  const upstream = httpRequest({ hostname: '127.0.0.1', port: nextPort, path: request.url, method: request.method, headers: request.headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end('Next fixture upstream unavailable'); });
  request.pipe(upstream);
});
app.on('connection', trackSocket);

// Next 16's development client uses the HMR socket to carry React debug
// chunks. Those chunks are part of the client Flight decoder in development,
// so forwarding only ordinary HTTP leaves hydration pending even though every
// document and JavaScript asset returns 200.
app.on('upgrade', (request, socket, head) => {
  trackSocket(socket);
  const url = new URL(request.url ?? '/', `https://app.awoof.test:${appPort}`);
  if (url.pathname !== '/_next/hmr' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const upstream = httpRequest({ hostname: '127.0.0.1', port: nextPort, path: request.url, method: request.method, headers: request.headers });
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    trackSocket(upstreamSocket);
    const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`;
    const headers = upstreamResponse.rawHeaders.map((value, index, values) => index % 2 === 0 ? `${value}: ${values[index + 1]}` : null).filter(Boolean);
    socket.write(`${status}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

function close() {
  if (closed) return;
  closed = true;
  api.close(); apiUpstream.close(); app.close();
  for (const socket of appSockets) socket.destroy();
  if (next && !next.killed) next.kill('SIGTERM');
  rmSync(fixtureDir, { recursive: true, force: true });
}
process.on('SIGINT', close); process.on('SIGTERM', close); process.on('exit', close);

next = spawn('npm', ['run', 'dev', '--', '--webpack', '--hostname', '127.0.0.1', '--port', String(nextPort)], {
  cwd: webRoot,
  env: {
    PATH: fixturePath,
    NODE_ENV: 'development',
    NEXT_PUBLIC_API_URL: `https://api.awoof.test:${apiPort}`,
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: 'inherit',
});
apiUpstream.listen(apiUpstreamPort, '127.0.0.1');
api.listen(apiPort, '127.0.0.1');
app.listen(appPort, '127.0.0.1', () => originalConsoleLog(`Microsoft HTTPS fixture ready at https://app.awoof.test:${appPort}`));
