'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { clearTokens, getSessionSnapshot } from '@/lib/auth';
import { studentSsoApiClient } from '@/lib/api-client';

type RecoveryStatus = 'loading' | 'unconfigured' | 'pending' | 'active' | 'unavailable';
const intentKey = 'awoof.recovery.intent.v1.tab';

type LinkedIdentity = { id: string; provider: 'google' | 'microsoft'; universityName: string; linkedAt: string };
const IDENTITY_PROVIDER_LABELS = { google: 'Google', microsoft: 'Microsoft' } as const;

/** The server exposes only opaque ids, provider, university, and link time — never subject material. */
function parseIdentities(value: unknown): LinkedIdentity[] | null {
    const list = (value as { identities?: unknown })?.identities;
    if (!Array.isArray(list)) return null;
    const parsed: LinkedIdentity[] = [];
    for (const item of list) {
        const v = item as Record<string, unknown>;
        if (typeof v.id !== 'string' || (v.provider !== 'google' && v.provider !== 'microsoft')
            || typeof v.universityName !== 'string' || typeof v.linkedAt !== 'string') return null;
        parsed.push({ id: v.id, provider: v.provider, universityName: v.universityName, linkedAt: v.linkedAt });
    }
    return parsed;
}

function linkedDate(value: string): string | null {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toLocaleDateString();
}

/** Only opaque server ids and operation names survive a provider redirect. No grant, code, or password is persisted. */
function saveIntent(intent: { purpose: 'recovery_code_generate' | 'recovery_code_activate'; pendingCodeId?: string }): boolean {
    try { sessionStorage.setItem(intentKey, JSON.stringify(intent)); return true; } catch { return false; }
}
function pendingIntent(): string | null { try { const value = JSON.parse(sessionStorage.getItem(intentKey) ?? '') as { purpose?: unknown; pendingCodeId?: unknown }; return value.purpose === 'recovery_code_activate' && typeof value.pendingCodeId === 'string' ? value.pendingCodeId : null; } catch { return null; } }

export default function StudentSecurityPage() {
    const { logout } = useAuth();
    const [status, setStatus] = useState<RecoveryStatus>('loading'); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false); const started = useRef(false);
    const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null);
    const [identitiesError, setIdentitiesError] = useState<string | null>(null);
    const [unlinkTarget, setUnlinkTarget] = useState<LinkedIdentity | null>(null);
    const [unlinkPassword, setUnlinkPassword] = useState(''); const [unlinkError, setUnlinkError] = useState<string | null>(null);
    const [unlinkBusy, setUnlinkBusy] = useState(false); const [signedOut, setSignedOut] = useState(false);
    const [pwPreferred, setPwPreferred] = useState(false);
    const [pwMode, setPwMode] = useState<'generate' | 'activate' | 'remove' | 'display' | null>(null);
    const [password, setPassword] = useState(''); const [pwOld, setPwOld] = useState(''); const [pwCode, setPwCode] = useState('');
    const [pwPendingId, setPwPendingId] = useState<string | null>(null); const [formError, setFormError] = useState<string | null>(null);
    const loadStatus = async (accessToken: string) => {
        try { const r = await studentSsoApiClient.get('/auth/student/sso/recovery-code', { headers: { Authorization: `Bearer ${accessToken}` } }); const data = (r.data as { data?: { status?: unknown; pendingCodeId?: unknown } }).data; const value = data?.status; setPendingCodeId(typeof data?.pendingCodeId === 'string' ? data.pendingCodeId : null); setStatus(value === 'active' || value === 'pending' || value === 'unconfigured' ? value : 'unavailable'); } catch { setStatus('unavailable'); }
    };
    const loadIdentities = async (accessToken: string) => {
        try {
            const r = await studentSsoApiClient.get('/auth/student/sso/identities', { headers: { Authorization: `Bearer ${accessToken}` } });
            const parsed = parseIdentities((r.data as { data?: unknown }).data);
            if (!parsed) throw new Error('invalid');
            setIdentities(parsed); setIdentitiesError(null);
        } catch { setIdentitiesError('School sign-ins could not be loaded. Sign in again and retry.'); }
    };
    useEffect(() => {
        if (started.current) return; started.current = true;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('unavailable'); return; }
        void loadStatus(session.accessToken);
        void loadIdentities(session.accessToken);
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
    const beginUnlink = async (target: LinkedIdentity) => {
        if (unlinkBusy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setUnlinkBusy(true); setUnlinkError(null);
        try {
            const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'unlink', targetIdentityId: target.id }, { headers: { Authorization: `Bearer ${session.accessToken}` } });
            const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl;
            if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid');
            window.location.assign(url);
        } catch { setUnlinkBusy(false); setUnlinkError('School sign-in confirmation could not start. Try again or use your password.'); }
    };
    const submitUnlinkPassword = async () => {
        const session = getSessionSnapshot(); if (!session.accessToken || unlinkBusy || !unlinkTarget || !unlinkPassword) return;
        setUnlinkBusy(true); setUnlinkError(null);
        const headers = { Authorization: `Bearer ${session.accessToken}` };
        const targetId = unlinkTarget.id;
        try {
            const reauth = await studentSsoApiClient.post('/auth/student/sso/reauth', { password: unlinkPassword, purpose: 'unlink', targetIdentityId: targetId }, { headers });
            const g = (reauth.data as { data?: { grantId?: unknown; grantSecret?: unknown } }).data;
            if (!g || typeof g.grantId !== 'string' || typeof g.grantSecret !== 'string') throw new Error('invalid grant');
            const response = await studentSsoApiClient.post(`/auth/student/sso/identities/${targetId}/unlink`, { reauthGrant: { grantId: g.grantId, grantSecret: g.grantSecret } }, { headers });
            const data = (response.data as { success?: unknown; data?: unknown })?.success === true ? (response.data as { data?: unknown }).data as { unlinked?: unknown; sessionRevoked?: unknown } : null;
            if (!data || data.unlinked !== true || typeof data.sessionRevoked !== 'boolean') throw new Error('invalid unlink');
            // The server clears the session only when the removed identity
            // issued it; drop local tokens exactly then, before rendering.
            if (data.sessionRevoked) { clearTokens(); setSignedOut(true); return; }
            setUnlinkTarget(null); setUnlinkPassword(''); await loadIdentities(session.accessToken);
        } catch (cause: unknown) {
            const failed = axios.isAxiosError(cause) ? cause.response : undefined;
            const code = (failed?.data as { error?: { code?: unknown } } | undefined)?.error?.code;
            setUnlinkError(failed?.status === 409 && code === 'SSO_LAST_LOGIN_METHOD' ? 'This is the last sign-in method. Link another school sign-in first.' : failed?.status === 401 ? 'Current password is incorrect.' : failed?.status === 403 ? 'This account has no password. Use school sign-in instead.' : 'Removal failed. Try again.');
        } finally { setUnlinkBusy(false); }
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
        <div className="mt-8 border-t pt-5 text-left">
            <h2 className="text-base font-semibold">School sign-ins</h2>
            <p className="mt-1 text-sm text-slate-600">School accounts linked to this Awoof account. Removing one needs fresh confirmation; the last sign-in method cannot be removed.</p>
            {signedOut ? <p role="status" className="mt-3 text-sm">The removed sign-in had issued this session, so you were signed out. <Link className="text-primary underline" href="/auth/student/login">Back to sign-in</Link></p>
            : identities === null && !identitiesError ? <p role="status" className="mt-3 text-sm text-slate-600">Loading school sign-ins…</p>
            : identitiesError ? <p role="alert" className="mt-3 text-sm text-red-600">{identitiesError}</p>
            : identities!.length === 0 ? <p role="status" className="mt-3 text-sm">No school sign-ins are linked.</p>
            : <ul className="mt-3 space-y-3">{identities!.map(identity => <li key={identity.id} className="rounded-2xl border px-4 py-3">
                <p className="text-sm font-medium">{IDENTITY_PROVIDER_LABELS[identity.provider]} · {identity.universityName}</p>
                {linkedDate(identity.linkedAt) ? <p className="text-sm text-slate-600">Linked {linkedDate(identity.linkedAt)}</p> : null}
                {unlinkTarget?.id === identity.id ? <div className="mt-3 space-y-2">
                    <p className="text-sm">Remove this school sign-in? It will no longer access this account.</p>
                    <label className="block text-sm" htmlFor="unlink-password">Current password<input id="unlink-password" type="password" autoComplete="current-password" value={unlinkPassword} onChange={e => setUnlinkPassword(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>
                    {unlinkError ? <p role="alert" className="text-sm text-red-600">{unlinkError}</p> : null}
                    <Button type="button" onClick={submitUnlinkPassword} disabled={unlinkBusy || !unlinkPassword} className="w-full rounded-full">Remove with password</Button>
                    <Button type="button" variant="outline" onClick={() => void beginUnlink(identity)} disabled={unlinkBusy} className="w-full rounded-full">Remove with school sign-in</Button>
                    <Button type="button" variant="ghost" onClick={() => { setUnlinkTarget(null); setUnlinkPassword(''); setUnlinkError(null); }} disabled={unlinkBusy} className="w-full rounded-full">Keep sign-in</Button>
                </div> : <Button type="button" variant="outline" onClick={() => { setUnlinkTarget(identity); setUnlinkPassword(''); setUnlinkError(null); }} disabled={unlinkBusy} className="mt-2 rounded-full">Remove</Button>}
            </li>)}</ul>}
            {signedOut ? null : <div className="mt-5 border-t pt-5">
                <p className="text-sm text-slate-600">Linking happens through school sign-in while signed out. After signing out, sign in with the school account and follow the link prompts.</p>
                <Button type="button" variant="outline" onClick={() => void logout()} className="mt-3 w-full rounded-full">Sign out and link a school sign-in</Button>
            </div>}
        </div>
    </AuthShell>;
}
