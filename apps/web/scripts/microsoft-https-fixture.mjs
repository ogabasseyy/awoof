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
import { join } from 'node:path';

const nextPort = 3107;
const appPort = 3443;
const apiPort = 3444;
const fixtureDir = mkdtempSync(join(tmpdir(), 'awoof-microsoft-https-'));
const keyPath = join(fixtureDir, 'key.pem');
const certPath = join(fixtureDir, 'cert.pem');
let next;
let closed = false;
let startCalls = 0;
let callbackCookieCalls = 0;
let finishCalls = 0;
const attempts = new Map();
const observedPaths = [];
const appSockets = new Set();
const accounts = new Map([
  ['00000000-0000-4000-8000-000000000001', { email: 'student-a@approved.test', emailEvidenceEligible: true, finishCalls: 0, linkedMicrosoftIdentities: 0 }],
  ['00000000-0000-4000-8000-000000000002', { email: 'student-b@approved.test', emailEvidenceEligible: false, finishCalls: 0, linkedMicrosoftIdentities: 0 }],
]);

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
  const origin = request.headers.origin;
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

function userFor(request) {
  const token = request.headers.authorization ?? '';
  if (!token.startsWith('Bearer student-access')) return null;
  const id = token.includes(':account-b')
    ? '00000000-0000-4000-8000-000000000002'
    : '00000000-0000-4000-8000-000000000001';
  return { id, email: accounts.get(id).email, role: 'student', verificationStatus: 'unverified' };
}

function modeFor(request) {
  return String(request.headers.authorization ?? '').split(':')[1] ?? 'success';
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

const api = createHttpsServer(tls, async (request, response) => {
  const url = new URL(request.url ?? '/', `https://api.awoof.test:${apiPort}`);
  observedPaths.push(`${request.method} ${url.pathname}`);
  if (request.method === 'OPTIONS') { cors(request, response); response.writeHead(204); response.end(); return; }
  if (url.pathname === '/api/__fixture/evidence') {
    json(request, response, 200, { data: {
      startCalls, finishCalls, callbackCookieCalls, observedPaths,
      accounts: Object.fromEntries([...accounts].map(([id, account]) => [id, {
        emailEvidenceEligible: account.emailEvidenceEligible,
        finishCalls: account.finishCalls,
        linkedMicrosoftIdentities: account.linkedMicrosoftIdentities,
      }])),
      attempts: [...attempts.values()].map(({ attemptId, ownerId, ready, callbackUsed, completed, callbackCookieCalls: attemptCallbackCookieCalls, finishCalls: attemptFinishCalls, finishCookieCalls, completionWrites }) => ({
        attemptId, ownerId, ready, callbackUsed, completed, callbackCookieCalls: attemptCallbackCookieCalls, finishCalls: attemptFinishCalls, finishCookieCalls, completionWrites,
      })),
    } }); return;
  }
  const user = userFor(request);
  if (url.pathname === '/api/auth/me') {
    json(request, response, user ? 200 : 401, user ? { success: true, data: user } : { success: false }); return;
  }
  if (url.pathname === '/api/verification/status') {
    const account = user ? accounts.get(user.id) : null;
    const statusFailure = modeFor(request) === 'status-failure' && Boolean(account?.finishCalls);
    json(request, response, statusFailure ? 503 : 200, statusFailure ? { error: { code: 'fixture_status_failure' } } : {
      success: true, data: {
        emailDomainApproved: true, mailboxConfirmed: Boolean(account?.emailEvidenceEligible), email: user?.email ?? 'unknown@approved.test', universityId: 'fixture-university',
        // Identity linking is deliberately not enrollment verification. The
        // fixture reports separate evidence sources, and only the account's
        // independent email evidence determines effective eligibility.
        eligibility: { eligible: Boolean(account?.emailEvidenceEligible), emailEvidenceEligible: Boolean(account?.emailEvidenceEligible), microsoftIdentityLinked: Boolean(account?.linkedMicrosoftIdentities) }, notices: { verification: { version: 'fixture-v1', text: 'Synthetic Awoof processing notice.' } },
      },
    }); return;
  }
  if (url.pathname === '/api/verification/methods/fixture-university') {
    json(request, response, 200, { data: { methods: [
      { methodType: 'email', isAvailable: true }, { methodType: 'microsoft', isAvailable: true },
    ] } }); return;
  }
  if (url.pathname === '/api/verification/consents') { json(request, response, 200, { data: { items: [], nextCursor: null } }); return; }
  if (url.pathname === '/api/verification/initiate' && request.method === 'POST') { json(request, response, 200, { data: { processingGrantId: 'fixture-processing-grant' } }); return; }
  if (url.pathname === '/api/verification/microsoft/notice') {
    json(request, response, 200, { data: { snapshot: { universityId: 'fixture-university', providerPolicyVersion: 1, noticeVersion: 'fixture-provider-v1', mode: 'identity_only', scopes: ['openid'] }, copy: { text: 'Synthetic provider consent for this isolated browser test.' } } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'GET') { json(request, response, 200, { data: { items: [], nextCursor: null } }); return; }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'POST') { await body(request); json(request, response, 200, { data: { providerConsentId: 'fixture-provider-consent' } }); return; }
  if (url.pathname === '/api/verification/microsoft/start' && request.method === 'POST') {
    await body(request);
    if (!user) { json(request, response, 401, { error: { code: 'fixture_auth_required' } }); return; }
    const attemptId = `fixture-attempt-${++startCalls}`;
    const state = `fixture-state-${attemptId}`;
    attempts.set(state, { attemptId, ownerId: user.id, ready: false, callbackUsed: false, completed: false, callbackCookieCalls: 0, finishCalls: 0, finishCookieCalls: 0, completionWrites: 0 });
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
    if (callbackAccepted) {
      callbackCookieCalls += 1;
      attempt.callbackCookieCalls += 1;
      attempt.ready = true;
      attempt.callbackUsed = true;
    }
    // The callback consumes the cookie before returning to the app. Finish is
    // intentionally authorized by the stored attempt/secret, never a cookie
    // that survived this redirect.
    const callbackHeaders = { 'set-cookie': '__Host-awoof-microsoft-fixture=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax' };
    if (callbackAccepted) {
      response.writeHead(303, { ...callbackHeaders, location: `https://app.awoof.test:${appPort}/student/verification/microsoft/complete?attempt=${encodeURIComponent(attempt.attemptId)}` });
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
    if (modeFor(request) === 'terminal') { json(request, response, 400, { error: { code: 'fixture_terminal_finish' } }); return; }
    if (modeFor(request) === 'transient') { json(request, response, 503, { error: { code: 'fixture_transient_finish' } }); return; }
    if (attempt.completed) {
      json(request, response, 200, { data: { accountLinked: true, enrollment: 'not_checked' } }); return;
    }
    attempt.completed = true;
    attempt.completionWrites += 1;
    accounts.get(user.id).linkedMicrosoftIdentities += 1;
    json(request, response, 200, { data: { accountLinked: true, enrollment: 'not_checked' } }); return;
  }
  json(request, response, 404, { error: { code: 'fixture_unknown_route', path: url.pathname } });
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
  api.close(); app.close();
  for (const socket of appSockets) socket.destroy();
  if (next && !next.killed) next.kill('SIGTERM');
  rmSync(fixtureDir, { recursive: true, force: true });
}
process.on('SIGINT', close); process.on('SIGTERM', close); process.on('exit', close);

next = spawn('npm', ['run', 'dev', '--', '--webpack', '--hostname', '127.0.0.1', '--port', String(nextPort)], {
  env: {
    ...process.env,
    NEXT_PUBLIC_API_URL: `https://api.awoof.test:${apiPort}`,
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: 'inherit',
});
api.listen(apiPort, '127.0.0.1');
app.listen(appPort, '127.0.0.1', () => console.log(`Microsoft HTTPS fixture ready at https://app.awoof.test:${appPort}`));
