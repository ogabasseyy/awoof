#!/usr/bin/env node
/**
 * Loopback-only visual preview for the existing Microsoft verification UI.
 * It is deliberately not the HTTPS/browser-contract fixture: no provider,
 * callback, database, environment credentials, or external service is used.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = 3455;
const nextPort = 3108;
const origin = `http://${host}:${port}`;
const sessionKey = 'awoof.session.v1';
const attemptKey = 'awoof.microsoft.verification.attempt.v1';
const realProject = fileURLToPath(new URL('..', import.meta.url));
const fixtureProject = mkdtempSync(join(tmpdir(), 'awoof-microsoft-visual-'));
const canaryKey = 'AWOOF_VISUAL_ENV_CANARY';
const childEnv = {
  LANG: process.env.LANG ?? 'C',
  PATH: process.env.PATH ?? '',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  NEXT_PUBLIC_API_URL: origin,
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_ENV: 'development',
};
let next;
let closed = false;
const sockets = new Set();
let globalOffIdentityUnlinked = false;

function linkSourceTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const nextSource = join(source, entry.name);
    const nextDestination = join(destination, entry.name);
    if (entry.isDirectory()) linkSourceTree(nextSource, nextDestination);
    else symlinkSync(nextSource, nextDestination);
  }
}

// Next loads `.env*` from its project root. Its route scanner does not follow
// a top-level source symlink, so this scaffold creates only directory entries
// and symlinks every real source file; it never copies or edits source.
linkSourceTree(join(realProject, 'src'), join(fixtureProject, 'src'));
for (const entry of ['public', 'node_modules', 'next.config.ts', 'postcss.config.mjs', 'package.json']) {
  symlinkSync(join(realProject, entry), join(fixtureProject, entry));
}
// Next may update compiler defaults in tsconfig during development. Keep that
// write confined to this owned temporary root, never the source worktree.
copyFileSync(join(realProject, 'tsconfig.json'), join(fixtureProject, 'tsconfig.json'));
const fixtureEnvFiles = readdirSync(fixtureProject).filter((entry) => entry === '.env' || entry.startsWith('.env.'));
if (fixtureEnvFiles.length || Object.hasOwn(childEnv, canaryKey)) throw new Error('Visual fixture environment isolation failed.');

const scenarios = {
  ineligible: {
    title: 'Ineligible student — Microsoft available',
    detail: 'Both processing and provider consents start unticked.',
    route: '/student/verification',
    mode: 'ineligible',
  },
  globalOff: {
    title: 'Microsoft globally off — email and history independent',
    detail: 'School-email verification, owner history, and unlinking a recorded connection remain available.',
    route: '/student/verification',
    mode: 'global-off',
  },
  noticeFailure: {
    title: 'Microsoft notice unavailable — history remains',
    detail: 'The notice error does not hide the owner consent history.',
    route: '/student/verification',
    mode: 'notice-failure',
  },
  identityOnly: {
    title: 'Identity-only completion',
    detail: 'Synthetic finish result explicitly says enrollment was not checked.',
    route: '/student/verification/microsoft/complete?attempt=visual-identity-attempt',
    mode: 'identity-only',
    attempt: { attemptId: 'visual-identity-attempt', finishSecret: 'visual-identity-secret' },
  },
  enrollment: {
    title: 'Positive synthetic enrollment completion',
    detail: 'Synthetic finish result labels current enrollment confirmed.',
    route: '/student/verification/microsoft/complete?attempt=visual-enrollment-attempt',
    mode: 'enrollment',
    attempt: { attemptId: 'visual-enrollment-attempt', finishSecret: 'visual-enrollment-secret' },
  },
  noTab: {
    title: 'No-tab completion',
    detail: 'The actual completion page rejects a route without tab state.',
    route: '/student/verification/microsoft/complete?attempt=visual-missing-attempt',
    mode: 'ineligible',
  },
  expired: {
    title: 'Expired completion',
    detail: 'The actual completion page clears expired synthetic tab state.',
    route: '/student/verification/microsoft/complete?attempt=visual-expired-attempt',
    mode: 'ineligible',
    attempt: { attemptId: 'visual-expired-attempt', finishSecret: 'visual-expired-secret', expired: true },
  },
  adminDiagnostics: {
    title: 'Admin diagnostic timeline',
    detail: 'Redacted timeline, fixed 30-day aggregates, and incomplete-attempt wording.',
    route: '/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20',
    mode: 'admin-diagnostics',
    sessionToken: 'visual-admin:admin-diagnostics',
  },
};

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function authContext(request) {
  const token = request.headers.authorization ?? '';
  if (token === 'Bearer visual-admin:admin-diagnostics') {
    return { mode: 'admin-diagnostics', user: { id: 'visual-admin-0001', email: 'synthetic.admin@approved.test', role: 'admin' } };
  }
  const match = /^Bearer visual-student:([a-z-]+)$/.exec(token);
  return match && scenarios[Object.keys(scenarios).find((key) => scenarios[key].mode === match[1]) ?? '']
    ? { mode: match[1], user: { id: 'visual-student-0001', email: 'synthetic.student@approved.test', role: 'student', verificationStatus: 'unverified' } }
    : null;
}

function history() {
  return [{
    id: 'visual-history-1',
    snapshot: { universityId: 'visual-university', providerPolicyVersion: 1, noticeVersion: 'visual-provider-v1', mode: 'identity_only', scopes: ['openid'] },
    acceptedAt: '2026-09-01T00:00:00.000Z', withdrawnAt: null,
  }];
}

function finish(mode) {
  return mode === 'enrollment'
    ? { accountLinked: true, enrollment: 'eligible' }
    : { accountLinked: true, enrollment: 'not_checked' };
}

function ownerIdentities(mode) {
  if (mode !== 'global-off') return [];
  return [{
    id: 'visual-microsoft-identity-1',
    universityId: 'visual-university',
    universityName: 'Synthetic approved institution',
    linkedAt: '2026-09-01T00:00:00.000Z',
    revokedAt: globalOffIdentityUnlinked ? '2026-09-13T00:00:00.000Z' : null,
    status: globalOffIdentityUnlinked ? 'revoked' : 'connected',
  }];
}

function api(request, response, url) {
  if (request.method === 'OPTIONS') { response.writeHead(204, { allow: 'GET, POST, OPTIONS' }); response.end(); return; }
  const context = authContext(request);
  if (url.pathname === '/api/auth/me') {
    json(response, context ? 200 : 401, context ? { success: true, data: context.user } : { success: false }); return;
  }
  if (!context) { json(response, 401, { error: { code: 'visual_fixture_auth_required', message: 'Synthetic fixture session required.' } }); return; }
  const mode = context.mode;
  if (url.pathname === '/api/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20') {
    if (context.user.role !== 'admin') { json(response, 403, { error: { code: 'visual_admin_required' } }); return; }
    json(response, 200, { success: true, data: {
      timeline: [
        { stage: 'started', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 2, recordedAt: '2026-09-13T09:00:00.000Z' },
        { stage: 'token_validated', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 7, recordedAt: '2026-09-13T09:00:03.000Z' },
        { stage: 'finished', outcome: 'failure', reason: 'permission_required', httpStatus: 403, durationMs: 18, recordedAt: '2026-09-13T09:00:05.000Z' },
      ],
      aggregateWindow: 'last_30_days', measuredAt: '2026-09-13T10:00:00.000Z', windowStartedAt: '2026-08-14T10:00:00.000Z',
      aggregates: [{ institutionId: 'visual-institution', institutionName: 'Synthetic approved institution', finishedAttemptCount: 1, averageFinishedRequestDurationMs: 18, p95FinishedRequestDurationMs: 18, incompleteAttempts: 1, failureCategories: [{ category: 'permission_required', eventCount: 1 }] }],
    } }); return;
  }
  if (url.pathname === '/api/verification/status') {
    const enrolled = mode === 'enrollment';
    json(response, 200, { data: {
      emailDomainApproved: true, mailboxConfirmed: mode === 'global-off', email: context.user.email, universityId: 'visual-university',
      eligibility: { eligible: enrolled, reason: enrolled ? 'Synthetic enrollment preview.' : 'Synthetic preview account is not currently eligible.', microsoftIdentityLinked: ownerIdentities(mode).some((identity) => identity.status === 'connected') },
      notices: { verification: { version: 'visual-v1', text: 'Synthetic Awoof processing notice for this local preview.' } },
    } }); return;
  }
  if (url.pathname === '/api/verification/methods/visual-university') {
    json(response, 200, { data: { methods: [
      { methodType: 'email', isAvailable: true },
      { methodType: 'microsoft', isAvailable: mode !== 'global-off', reason: mode === 'global-off' ? 'Microsoft connections are temporarily unavailable.' : undefined },
    ] } }); return;
  }
  if (url.pathname === '/api/verification/consents') { json(response, 200, { data: { items: [], nextCursor: null } }); return; }
  if (url.pathname === '/api/verification/initiate' && request.method === 'POST') { json(response, 200, { data: { processingGrantId: 'visual-processing-grant' } }); return; }
  if (url.pathname === '/api/verification/email/request' && request.method === 'POST') { json(response, 200, { data: { challengeId: 'visual-email-challenge', resendAvailableAt: '2099-01-01T00:00:00.000Z' } }); return; }
  if (url.pathname === '/api/verification/microsoft/notice') {
    if (mode === 'notice-failure') { json(response, 503, { error: { code: 'visual_notice_unavailable' } }); return; }
    json(response, 200, { data: { snapshot: { universityId: 'visual-university', providerPolicyVersion: 1, noticeVersion: 'visual-provider-v1', mode: 'identity_only', scopes: ['openid'] }, copy: { text: 'Synthetic provider consent for this isolated visual preview.' } } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'GET') {
    json(response, 200, { data: { items: mode === 'global-off' || mode === 'notice-failure' ? history() : [], nextCursor: null } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/consents' && request.method === 'POST') { json(response, 200, { data: { providerConsentId: 'visual-provider-consent' } }); return; }
  if (url.pathname === '/api/verification/microsoft/identities' && request.method === 'GET') {
    json(response, 200, { data: { items: ownerIdentities(mode), nextCursor: null } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/identities/visual-microsoft-identity-1/unlink' && request.method === 'POST') {
    if (mode !== 'global-off') { json(response, 404, { error: { code: 'visual_identity_not_found' } }); return; }
    globalOffIdentityUnlinked = true;
    json(response, 200, { data: { identityId: 'visual-microsoft-identity-1', unlinked: true, recovery: 'support_required' } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/start' && request.method === 'POST') {
    // Intentional safety boundary: this preview cannot issue a real provider destination.
    json(response, 503, { error: { code: 'visual_provider_navigation_blocked', message: 'Synthetic visual preview blocks Microsoft navigation. No provider connection was started.' } }); return;
  }
  if (url.pathname === '/api/verification/microsoft/finish' && request.method === 'POST') {
    json(response, 200, { data: finish(mode) }); return;
  }
  json(response, 404, { error: { code: 'visual_fixture_unknown_route' } });
}

function landing() {
  const cards = Object.entries(scenarios).map(([key, scenario]) => `<li><a data-scenario="${key}" href="#${key}"><strong>${scenario.title}</strong><span>${scenario.detail}</span></a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Awoof Microsoft visual preview</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f4f7fd;color:#172033}.wrap{max-width:760px;margin:48px auto;padding:0 20px}.flag{background:#fff5d7;border:1px solid #e8c466;padding:14px;border-radius:12px}ul{padding:0;display:grid;gap:12px}li{list-style:none}a{display:block;background:white;border:1px solid #dbe3f0;border-radius:14px;padding:16px;color:inherit;text-decoration:none}a:hover,a:focus{border-color:#1d4ed8;outline:3px solid #bfdbfe}strong,span{display:block}span{color:#526076;margin-top:4px;font-size:.92rem}</style></head><body><main class="wrap"><p class="flag"><strong>Local synthetic visual preview</strong>Loopback only. These links establish fixed synthetic browser state and open real Awoof verification or administrator components. No Microsoft, database, credentials, or external API is contacted.</p><h1>Microsoft verification UI scenarios</h1><p>Choose a scenario. “Continue with Microsoft” is deliberately blocked in this fixture and will not navigate away.</p><ul>${cards}</ul></main><script>const scenarios=${JSON.stringify(scenarios)};const sessionKey=${JSON.stringify(sessionKey)};const attemptKey=${JSON.stringify(attemptKey)};document.querySelectorAll('[data-scenario]').forEach((link)=>link.addEventListener('click',(event)=>{event.preventDefault();const scenario=scenarios[link.dataset.scenario];if(!scenario)return;const sessionId='visual-browser-'+link.dataset.scenario;localStorage.setItem(sessionKey,JSON.stringify({v:1,state:'active',sessionId,accessToken:scenario.sessionToken||'visual-student:'+scenario.mode,refreshToken:'visual-refresh-'+scenario.mode}));sessionStorage.removeItem(attemptKey);if(scenario.attempt){sessionStorage.setItem(attemptKey,JSON.stringify({...scenario.attempt,browserSessionId:sessionId,expiresAt:scenario.attempt.expired?Date.now()-1:Date.now()+9*60*1000}));}location.assign(scenario.route);}));</script></body></html>`;
}

function csp(response) {
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

const server = createServer((request, response) => {
  csp(response);
  const url = new URL(request.url ?? '/', origin);
  if (url.pathname === '/__fixture/microsoft-visual') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(landing()); return; }
  if (url.pathname === '/__fixture/microsoft-visual/isolation') {
    json(response, 200, { data: { fixtureProjectHasEnvFiles: fixtureEnvFiles.length > 0, unallowlistedCanaryInherited: Object.hasOwn(childEnv, canaryKey) } }); return;
  }
  if (url.pathname.startsWith('/api/')) { api(request, response, url); return; }
  const upstream = httpRequest({ hostname: host, port: nextPort, path: request.url, method: request.method, headers: { ...request.headers, host: `${host}:${port}` } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Next visual fixture upstream unavailable'); });
  request.pipe(upstream);
});

server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', origin);
  if (url.pathname !== '/_next/hmr' || request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const upstream = httpRequest({ hostname: host, port: nextPort, path: request.url, method: request.method, headers: { ...request.headers, host: `${host}:${port}` } });
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    sockets.add(upstreamSocket);
    upstreamSocket.on('close', () => sockets.delete(upstreamSocket));
    upstreamSocket.on('error', () => {});
    const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`;
    const headers = upstreamResponse.rawHeaders.filter((_, index) => index % 2 === 0).map((name, index) => `${name}: ${upstreamResponse.rawHeaders[index * 2 + 1]}`);
    socket.write(`${status}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head); if (upstreamHead.length) socket.write(upstreamHead);
    socket.on('close', () => upstreamSocket.destroy()); upstreamSocket.on('close', () => socket.destroy()); upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on('error', () => socket.destroy()); upstream.end();
});

function close() {
  if (closed) return;
  closed = true;
  server.close();
  for (const socket of sockets) socket.destroy();
  // `npm run dev` can have a Next child. It is spawned in its own process
  // group, so shutdown reaches only this fixture's process tree.
  if (next && !next.killed) {
    next.once('exit', removeFixtureProject);
    try { process.kill(-next.pid, 'SIGTERM'); } catch { next.kill('SIGTERM'); }
  } else removeFixtureProject();
}
function removeFixtureProject() {
  try { rmSync(fixtureProject, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { setTimeout(removeFixtureProject, 100); }
}
process.on('SIGINT', close); process.on('SIGTERM', close); process.once('exit', () => { try { rmSync(fixtureProject, { recursive: true, force: true }); } catch {} });

next = spawn(process.execPath, [join(realProject, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', host, '--port', String(nextPort)], {
  cwd: fixtureProject, env: childEnv, stdio: 'inherit', detached: true,
});
server.listen(port, host, () => console.log(`Microsoft visual fixture ready at ${origin}/__fixture/microsoft-visual (PID ${process.pid}; Ctrl-C to stop)`));
