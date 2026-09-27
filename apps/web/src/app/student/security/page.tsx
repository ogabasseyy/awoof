'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { getSessionSnapshot } from '@/lib/auth';
import { studentSsoApiClient } from '@/lib/api-client';

type RecoveryStatus = 'loading' | 'unconfigured' | 'pending' | 'active' | 'unavailable';
const intentKey = 'awoof.recovery.intent.v1.tab';

/** Only opaque server ids and operation names survive a provider redirect. No grant, code, or password is persisted. */
function saveIntent(intent: { purpose: 'recovery_code_generate' | 'recovery_code_activate'; pendingCodeId?: string }): boolean {
    try { sessionStorage.setItem(intentKey, JSON.stringify(intent)); return true; } catch { return false; }
}
function pendingIntent(): string | null { try { const value = JSON.parse(sessionStorage.getItem(intentKey) ?? '') as { purpose?: unknown; pendingCodeId?: unknown }; return value.purpose === 'recovery_code_activate' && typeof value.pendingCodeId === 'string' ? value.pendingCodeId : null; } catch { return null; } }

export default function StudentSecurityPage() {
    const [status, setStatus] = useState<RecoveryStatus>('loading'); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false); const started = useRef(false);
    const [pwPreferred, setPwPreferred] = useState(false);
    const [pwMode, setPwMode] = useState<'generate' | 'activate' | 'remove' | 'display' | null>(null);
    const [password, setPassword] = useState(''); const [pwOld, setPwOld] = useState(''); const [pwCode, setPwCode] = useState('');
    const [pwPendingId, setPwPendingId] = useState<string | null>(null); const [formError, setFormError] = useState<string | null>(null);
    const loadStatus = async (accessToken: string) => {
        try { const r = await studentSsoApiClient.get('/auth/student/sso/recovery-code', { headers: { Authorization: `Bearer ${accessToken}` } }); const data = (r.data as { data?: { status?: unknown; pendingCodeId?: unknown } }).data; const value = data?.status; setPendingCodeId(typeof data?.pendingCodeId === 'string' ? data.pendingCodeId : null); setStatus(value === 'active' || value === 'pending' || value === 'unconfigured' ? value : 'unavailable'); } catch { setStatus('unavailable'); }
    };
    useEffect(() => {
        if (started.current) return; started.current = true;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('unavailable'); return; }
        void loadStatus(session.accessToken);
    }, []);
    const begin = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true);
        try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_generate' }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const beginRemove = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true); try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_remove' }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error(); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const beginActivation = async () => {
        const pendingId = pendingCodeId ?? pendingIntent(); const session = getSessionSnapshot(); if (!pendingId || !session.accessToken || busy) { setStatus('unavailable'); return; }
        setBusy(true); try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_activate', pendingCodeId: pendingId }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const cancelPending = async () => {
        const session = getSessionSnapshot(); if (!pendingCodeId || !session.accessToken || busy) return;
        setBusy(true); try { await studentSsoApiClient.post('/auth/student/sso/recovery-code/cancel', { pendingCodeId }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); setPendingCodeId(null); await loadStatus(session.accessToken); } catch { setStatus('unavailable'); } finally { setBusy(false); }
    };
    const startPassword = (mode: 'generate' | 'activate' | 'remove') => {
        const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        if (mode === 'activate') { const id = pendingCodeId ?? pendingIntent(); if (!id) { setStatus('unavailable'); return; } setPwPendingId(id); }
        setPassword(''); setPwOld(''); setPwCode(''); setFormError(null); setPwMode(mode);
    };
    const submitPassword = async () => {
        const session = getSessionSnapshot(); if (!session.accessToken || busy || !pwMode || !password) return;
        if (pwMode === 'remove' && !pwOld) { setFormError('Enter the current recovery code.'); return; }
        if (pwMode === 'activate' && !pwCode) { setFormError('Re-enter the saved recovery code.'); return; }
        setBusy(true); setFormError(null);
        const headers = { Authorization: `Bearer ${session.accessToken}` };
        try {
            const purpose = pwMode === 'generate' ? 'recovery_code_generate' : pwMode === 'activate' ? 'recovery_code_activate' : 'recovery_code_remove';
            const reauth = await studentSsoApiClient.post('/auth/student/sso/reauth', pwMode === 'activate' && pwPendingId ? { password, purpose, pendingCodeId: pwPendingId } : { password, purpose }, { headers });
            const g = (reauth.data as { data?: { grantId?: unknown; grantSecret?: unknown } }).data;
            if (!g || typeof g.grantId !== 'string' || typeof g.grantSecret !== 'string') throw new Error('invalid grant');
            const reauthGrant = { grantId: g.grantId, grantSecret: g.grantSecret };
            if (pwMode === 'generate') {
                const generated = await studentSsoApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant, ...(pwOld ? { oldCode: pwOld } : {}) }, { headers });
                const data = (generated.data as { data?: { pendingCodeId?: unknown; code?: unknown } }).data;
                if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error('invalid code');
                setPwPendingId(data.pendingCodeId); setPwCode(data.code); setPassword(''); setPwMode('display'); return;
            }
            if (pwMode === 'activate' && pwPendingId) {
                await studentSsoApiClient.post('/auth/student/sso/recovery-code/activate', { reauthGrant, pendingCodeId: pwPendingId, code: pwCode, ...(pwOld ? { oldCode: pwOld } : {}) }, { headers });
            } else if (pwMode === 'remove') {
                await studentSsoApiClient.post('/auth/student/sso/recovery-code/remove', { reauthGrant, oldCode: pwOld }, { headers });
            } else { throw new Error('invalid state'); }
            setPwMode(null); setPassword(''); setPwOld(''); setPwCode(''); setPwPendingId(null); await loadStatus(session.accessToken);
        } catch (cause: unknown) {
            const code = axios.isAxiosError(cause) ? cause.response?.status : undefined;
            setFormError(code === 401 ? 'Current password is incorrect.' : code === 403 ? 'This account has no password. Use school sign-in instead.' : 'Password confirmation failed. Check the entries and try again.');
        } finally { setBusy(false); }
    };
    if (status === 'unavailable') return <AuthShell role="student" title="Account security" subtitle="Security setup is unavailable." footer={null}><p role="status">Sign in again and retry. If school sign-in is unavailable, use recovery only if you already saved a recovery code.</p><Link className="mt-5 inline-block text-primary underline" href="/auth/student/recovery">Account recovery</Link></AuthShell>;
    if (pwMode === 'display') return <AuthShell role="student" title="Save your recovery code" subtitle="Shown once. It will not be displayed again." footer={null}><p role="status" className="break-all rounded-2xl border px-4 py-3 text-left font-mono text-sm">{pwCode}</p><Button type="button" onClick={() => { setPwCode(''); setPwMode('activate'); }} className="mt-5 w-full rounded-full">I saved my code</Button></AuthShell>;
    if (pwMode) return <AuthShell role="student" title="Confirm with your password" subtitle={pwMode === 'generate' ? 'Password confirmation for a new code.' : pwMode === 'activate' ? 'Password confirmation to activate the saved code.' : 'Password confirmation to remove the code.'} footer={null}>
        <div className="space-y-3"><label className="block text-left text-sm" htmlFor="recovery-password">Current password<input id="recovery-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>
        {pwMode === 'activate' ? <label className="block text-left text-sm" htmlFor="recovery-code-confirm">Re-enter saved recovery code<input id="recovery-code-confirm" value={pwCode} onChange={e => setPwCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label> : null}
        <label className="block text-left text-sm" htmlFor="recovery-code-current">{pwMode === 'remove' ? 'Current recovery code' : 'Current recovery code (required when replacing)'}<input id="recovery-code-current" value={pwOld} onChange={e => setPwOld(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label></div>
        {formError ? <p role="alert" className="mt-3 text-sm text-red-600">{formError}</p> : null}
        <Button type="button" onClick={submitPassword} disabled={busy} className="mt-5 w-full rounded-full">{pwMode === 'generate' ? 'Generate code' : pwMode === 'activate' ? 'Activate code' : 'Remove code'}</Button>
        <Button type="button" variant="outline" onClick={() => { setPwMode(null); setFormError(null); }} disabled={busy} className="mt-2 w-full rounded-full">Back</Button>
    </AuthShell>;
    const methodToggle = <Button type="button" variant="ghost" onClick={() => setPwPreferred(!pwPreferred)} disabled={busy} className="w-full rounded-full">{pwPreferred ? 'Use school sign-in instead' : 'Use your password instead'}</Button>;
    return <AuthShell role="student" title="Account security" subtitle="Optional recovery-code setup." footer={null}>
        <p className="text-left text-sm text-slate-600">Confirm your identity, save your code, then confirm your identity again to activate it. The code is shown once and is never stored in this browser, emailed, or placed in a URL. Recovery also needs access to your school mailbox; it does not promise permanent access.</p>
        {status === 'active' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A recovery code is active. Replacing or removing it requires the current code and fresh confirmation.</p><Button type="button" onClick={() => pwPreferred ? startPassword('generate') : begin()} disabled={busy} className="w-full rounded-full">Replace recovery code</Button><Button type="button" variant="outline" onClick={() => pwPreferred ? startPassword('remove') : beginRemove()} disabled={busy} className="w-full rounded-full">Remove recovery code</Button>{methodToggle}</div> : status === 'pending' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A pending code exists but cannot recover your account. Confirm your identity again before it expires.</p><Button type="button" onClick={() => pwPreferred ? startPassword('activate') : beginActivation()} disabled={busy || !pendingCodeId} className="w-full rounded-full">Confirm identity to activate saved code</Button><Button type="button" variant="outline" onClick={cancelPending} disabled={busy || !pendingCodeId} className="w-full rounded-full">Cancel pending code</Button>{methodToggle}</div> : <div className="mt-5 space-y-2"><Button type="button" onClick={() => pwPreferred ? startPassword('generate') : begin()} disabled={busy || status === 'loading'} className="w-full rounded-full">{busy ? (pwPreferred ? 'Working…' : 'Redirecting…') : 'Confirm identity to generate a code'}</Button>{methodToggle}</div>}
    </AuthShell>;
}
