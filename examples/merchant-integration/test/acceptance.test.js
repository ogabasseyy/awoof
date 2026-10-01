import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createMerchant } from '../server.js';
import { createSimulator } from '../simulator.js';
const productId = '11111111-1111-4111-8111-111111111111';
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function listen(server, port) { await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); }
async function close(app) { await new Promise(resolve => app.server.close(resolve)); app.store.close(); }
test('synthetic full browser checkout rejects nonce/replay and persists a single report across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awoof-reference-')); const merchantPort = await freePort(); const simulatorPort = await freePort();
  const origin = `http://127.0.0.1:${merchantPort}`; const simulatorOrigin = `http://localhost:${simulatorPort}`;
  const simulator = createSimulator({ origin: simulatorOrigin, merchantOrigin: origin, dbPath: join(directory, 'sim.sqlite') });
  const options = { origin, apiOrigin: simulatorOrigin, webOrigin: simulatorOrigin, privateKey: 'awoof_synthetic_local_only', productId, vendorId: 'vendor', amountKobo: 80000, synthetic: true, dbPath: join(directory, 'merchant.sqlite') };
  let merchant = createMerchant(options); await listen(simulator.server, simulatorPort); await listen(merchant.server, merchantPort);
  const request = (path, init = {}) => fetch(`${origin}${path}`, { redirect: 'manual', ...init, headers: { Connection: 'close', ...init.headers } });
  try {
    assert.equal((await request('/checkout', { method: 'POST' })).status, 403);
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } });
    const cookie = start.headers.get('set-cookie').split(';')[0]; assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const hosted = start.headers.get('location'); assert.match(hosted, /\/marketplace\/.*\?claimSession=/);
    assert.equal(hosted.includes(cookie.split('=')[1]), false);
    const session = new URL(hosted).searchParams.get('claimSession');
    const simulate = async scenario => fetch(`${simulatorOrigin}/synthetic/claim`, { method: 'POST', redirect: 'manual', headers: { Origin: simulatorOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ session, scenario }) });
    assert.equal((await simulate('ineligible')).status, 403); assert.equal((await simulate('expired')).status, 409);
    assert.equal(merchant.store.find(row => row.session.claimSessionId === session).receipt, undefined);
    const claim = await simulate('eligible'); const callback = new URL(claim.headers.get('location'));
    assert.equal((await request(callback.pathname + callback.search)).status, 403);
    assert.equal((await request(callback.pathname + callback.search, { headers: { Cookie: 'awoof_reference_nonce=' + 'f'.repeat(64) } })).status, 403);
    const startedOther = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const otherCookie = startedOther.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(callback.pathname + callback.search, { headers: { Cookie: otherCookie } })).status, 400);
    // A definitively rejected cross-checkout code must not poison its legitimate claim.
    const otherSession = new URL(startedOther.headers.get('location')).searchParams.get('claimSession');
    assert.equal(merchant.store.find(row => row.session.claimSessionId === otherSession).codeHash, undefined);
    const otherClaim = await fetch(`${simulatorOrigin}/synthetic/claim`, { method: 'POST', redirect: 'manual', headers: { Origin: simulatorOrigin }, body: new URLSearchParams({ session: otherSession, scenario: 'eligible' }) });
    const otherCallback = new URL(otherClaim.headers.get('location'));
    assert.equal((await request(otherCallback.pathname + otherCallback.search, { headers: { Cookie: otherCookie } })).status, 303);
    const conflictingCallbacks = await Promise.all([
      request(callback.pathname + callback.search, { headers: { Cookie: cookie } }),
      request('/awoof/student-claim?assertion=' + 'c'.repeat(43), { headers: { Cookie: cookie } }),
    ]);
    assert.equal(conflictingCallbacks[0].status, 303); assert.ok([400, 409].includes(conflictingCallbacks[1].status));
    const identicalCallbacks = await Promise.all([request(callback.pathname + callback.search, { headers: { Cookie: cookie } }), request(callback.pathname + callback.search, { headers: { Cookie: cookie } })]);
    assert.deepEqual(identicalCallbacks.map(response => response.status), [303, 303]);
    const pay = () => request('/payments/simulate', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    await Promise.all([pay(), pay()]);
    let row = merchant.store.find(row => row.session.claimSessionId === session); assert.equal(row.state, 'reported');
    const transactionId = row.report.transactionId;
    await close(merchant); merchant = createMerchant(options); await listen(merchant.server, merchantPort);
    await pay(); row = merchant.store.get(row.id); assert.equal(row.report.transactionId, transactionId);
    const reports = simulator.store.db.prepare('SELECT value FROM records').all().map(row => JSON.parse(row.value)).filter(row => row.report); assert.equal(reports.length, 1);
    assert.equal((await request('/reconcile', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/webhooks/paystack', { method: 'POST' })).status, 503);
  } finally { await close(merchant); await close(simulator); rmSync(directory, { recursive: true, force: true }); }
});
