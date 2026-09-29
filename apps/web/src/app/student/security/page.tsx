'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { clearTokens, getSessionSnapshot } from '@/lib/auth';
import { refreshSessionAccessToken, studentSsoApiClient, studentSsoSessionApiClient } from '@/lib/api-client';
import { serverSkewSince } from '@/lib/student-login-flow';

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

function formatPendingRemaining(deadlineMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const IDENTITIES_UNAVAILABLE = 'School sign-ins could not be loaded. Sign in again and retry.';

function pendingIntent(): string | null { try { const value = JSON.parse(sessionStorage.getItem(intentKey) ?? '') as { purpose?: unknown; pendingCodeId?: unknown }; return value.purpose === 'recovery_code_activate' && typeof value.pendingCodeId === 'string' ? value.pendingCodeId : null; } catch { return null; } }

export default function StudentSecurityPage() {
    const { refreshUser, user } = useAuth();
    // Post-recovery re-enrollment must use the password: generate()
    // rejects provider-backed grants while the marker stands, so the
    // enrollment views require the password path instead of offering a
    // doomed school-sign-in round-trip. Activation clears the marker and
    // the post-activation refreshUser restores the toggle.
    const passwordOnlyEnrollment = user?.recoveryReenrollmentRequired === true;
    const [status, setStatus] = useState<RecoveryStatus>('loading'); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null);
    const [pendingExpiresAt, setPendingExpiresAt] = useState<string | null>(null);
    const [generation, setGeneration] = useState<number | null>(null);
    const [busy, setBusy] = useState(false); const loadedUserId = useRef<string | null | undefined>(undefined);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    // The ten-minute activation deadline is displayed and enforced in the
    // UI: at expiry the pending views swap to an explicit restart state
    // instead of letting activation degrade into a generic failure. The
    // server clock travels with each deadline so skewed devices evaluate
    // it on server time instead of expiring a live code early.
    const [skewMs, setSkewMs] = useState(0);
    const [pwSkewMs, setPwSkewMs] = useState(0);
    const pendingDeadlineMs = pendingExpiresAt ? Date.parse(pendingExpiresAt) : NaN;
    const pendingExpired = status === 'pending' && pendingExpiresAt !== null && !Number.isNaN(pendingDeadlineMs) && pendingDeadlineMs <= now + skewMs;
    const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null);
    const [identitiesError, setIdentitiesError] = useState<string | null>(null);
    const [unlinkTarget, setUnlinkTarget] = useState<LinkedIdentity | null>(null);
    const [unlinkPassword, setUnlinkPassword] = useState(''); const [unlinkError, setUnlinkError] = useState<string | null>(null);
    const [unlinkBusy, setUnlinkBusy] = useState(false); const [signedOut, setSignedOut] = useState(false);
    const [linkError, setLinkError] = useState<string | null>(null); const [linkBusy, setLinkBusy] = useState(false);
    const [schoolError, setSchoolError] = useState<string | null>(null);
    const [pwPreferred, setPwPreferred] = useState(false);
    const [pwMode, setPwMode] = useState<'generate' | 'activate' | 'remove' | 'display' | null>(null);
    const [password, setPassword] = useState(''); const [pwOld, setPwOld] = useState(''); const [pwCode, setPwCode] = useState('');
    const [pwPendingId, setPwPendingId] = useState<string | null>(null); const [pwExpiresAt, setPwExpiresAt] = useState<string | null>(null); const [formError, setFormError] = useState<string | null>(null);
    const [pwExpectedGeneration, setPwExpectedGeneration] = useState<number | null>(null);
    const pwDeadlineMs = pwExpiresAt ? Date.parse(pwExpiresAt) : NaN;
    const pwExpired = (pwMode === 'display' || pwMode === 'activate') && pwExpiresAt !== null && !Number.isNaN(pwDeadlineMs) && pwDeadlineMs <= now + pwSkewMs;
    // The session client refreshes a token that expired before this page
    // loaded instead of permanently rendering recovery and identity
    // management as unavailable after one 401.
    const loadStatus = async () => {
        try { const r = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code'); const data = (r.data as { data?: { status?: unknown; generation?: unknown; pendingCodeId?: unknown; pendingExpiresAt?: unknown; serverNow?: unknown } }).data; const value = data?.status; setPendingCodeId(typeof data?.pendingCodeId === 'string' ? data.pendingCodeId : null); setPendingExpiresAt(typeof data?.pendingExpiresAt === 'string' ? data.pendingExpiresAt : null); setGeneration(typeof data?.generation === 'number' ? data.generation : null); setSkewMs(serverSkewSince(typeof data?.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null)); setStatus(value === 'active' || value === 'pending' || value === 'unconfigured' ? value : 'unavailable'); } catch { setStatus('unavailable'); }
    };
    const loadIdentities = async () => {
        try {
            const r = await studentSsoSessionApiClient.get('/auth/student/sso/identities');
            const parsed = parseIdentities((r.data as { data?: unknown }).data);
            if (!parsed) throw new Error('invalid');
            setIdentities(parsed); setIdentitiesError(null);
        } catch { setIdentitiesError(IDENTITIES_UNAVAILABLE); }
    };
    const currentUserId = user?.id ?? null;
    useEffect(() => {
        if (loadedUserId.current === currentUserId) return;
        loadedUserId.current = currentUserId;
        // Another tab can replace the session while this page stays open:
        // never keep the previous account's recovery status, identities,
        // or pending unlink target on screen. Reset to loading and refetch
        // for whoever is signed in now.
        setStatus('loading'); setIdentities(null); setIdentitiesError(null); setUnlinkTarget(null);
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('unavailable'); setIdentitiesError(IDENTITIES_UNAVAILABLE); return; }
        void loadStatus();
        void loadIdentities();
    }, [currentUserId]);
    // A failed school-sign-in start must not strand password users: the
    // provider-independent password flow stays usable, so these report an
    // inline error and keep the password toggle instead of marking the
    // whole page unavailable.
    const schoolUnavailable = 'School sign-in confirmation is unavailable right now. Use your password instead or try again.';
    const begin = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true); setSchoolError(null);
        try { const r = await studentSsoSessionApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_generate' }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setSchoolError(schoolUnavailable); }
    };
    const beginRemove = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true); setSchoolError(null); try { const r = await studentSsoSessionApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_remove' }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error(); window.location.assign(url); } catch { setBusy(false); setSchoolError(schoolUnavailable); }
    };
    const beginActivation = async () => {
        if (busy) return;
        const pendingId = pendingCodeId ?? pendingIntent(); const session = getSessionSnapshot(); if (!pendingId || !session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true); setSchoolError(null); try { const r = await studentSsoSessionApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_activate', pendingCodeId: pendingId }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setSchoolError(schoolUnavailable); }
    };
    const cancelPending = async () => {
        const session = getSessionSnapshot(); if (!pendingCodeId || !session.accessToken || busy) return;
        setBusy(true); try { await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/cancel', { pendingCodeId }); setPendingCodeId(null); await loadStatus(); } catch { setStatus('unavailable'); } finally { setBusy(false); }
    };
    const startPassword = (mode: 'generate' | 'activate' | 'remove') => {
        const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        // The expected generation binds ambiguous-activation
        // reconciliation, mirroring the provider-backed path: success
        // requires the reloaded active generation to match the pending one
        // being activated, not merely any active code.
        if (mode === 'activate') { const id = pendingCodeId ?? pendingIntent(); if (!id) { setStatus('unavailable'); return; } setPwPendingId(id); setPwExpiresAt(id === pendingCodeId ? pendingExpiresAt : null); setPwExpectedGeneration(id === pendingCodeId ? generation : null); }
        setPassword(''); setPwOld(''); setPwCode(''); setFormError(null); setPwMode(mode);
    };
    const submitPassword = async () => {
        const session = getSessionSnapshot(); if (!session.accessToken || busy || !pwMode || !password) return;
        if (pwMode === 'remove' && !pwOld) { setFormError('Enter the current recovery code.'); return; }
        if (pwMode === 'activate' && !pwCode) { setFormError('Re-enter the saved recovery code.'); return; }
        // Reconcile baseline: ambiguous failures compare the reloaded
        // status against the pre-submit pending, not just its presence.
        // Activation additionally requires the generation to match: a
        // cancelled or expired pending falls back to reporting the older
        // active code, which must not read as the replacement succeeding.
        const submittedMode = pwMode; const priorPendingId = pendingCodeId; const expectedGeneration = pwExpectedGeneration;
        setBusy(true); setFormError(null);
        // The raw password travels on the non-refreshing client, so the
        // token is renewed first: a stale snapshot would 401 before the
        // password is checked and misreport as "incorrect" with no recovery.
        let headers: { Authorization: string };
        try {
            headers = { Authorization: `Bearer ${await refreshSessionAccessToken()}` };
        } catch {
            setBusy(false);
            setFormError('Your session expired. Sign in again and retry.');
            return;
        }
        try {
            const purpose = pwMode === 'generate' ? 'recovery_code_generate' : pwMode === 'activate' ? 'recovery_code_activate' : 'recovery_code_remove';
            const reauth = await studentSsoApiClient.post('/auth/student/sso/reauth', pwMode === 'activate' && pwPendingId ? { password, purpose, pendingCodeId: pwPendingId } : { password, purpose }, { headers });
            const g = (reauth.data as { data?: { grantId?: unknown; grantSecret?: unknown } }).data;
            if (!g || typeof g.grantId !== 'string' || typeof g.grantSecret !== 'string') throw new Error('invalid grant');
            const reauthGrant = { grantId: g.grantId, grantSecret: g.grantSecret };
            if (pwMode === 'generate') {
                const generated = await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant, ...(pwOld ? { oldCode: pwOld } : {}) });
                const data = (generated.data as { data?: { pendingCodeId?: unknown; code?: unknown; generation?: unknown; expiresAt?: unknown; serverNow?: unknown } }).data;
                if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error('invalid code');
                setPwPendingId(data.pendingCodeId); setPwCode(data.code); setPassword('');
                setPwExpectedGeneration(typeof data.generation === 'number' ? data.generation : null);
                setPwExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null);
                setPwSkewMs(serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null));
                setPwMode('display'); return;
            }
            if (pwMode === 'activate' && pwPendingId) {
                await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/activate', { reauthGrant, pendingCodeId: pwPendingId, code: pwCode, ...(pwOld ? { oldCode: pwOld } : {}) });
            } else if (pwMode === 'remove') {
                await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/remove', { reauthGrant, oldCode: pwOld });
            } else { throw new Error('invalid state'); }
            setPwMode(null); setPassword(''); setPwOld(''); setPwCode(''); setPwPendingId(null); setPwExpiresAt(null); await loadStatus();
            // Activation clears the server re-enrollment marker; refresh the
            // account so post-recovery notices disappear without a reload.
            await refreshUser().catch(() => undefined);
        } catch (cause: unknown) {
            const failed = axios.isAxiosError(cause) ? cause.response?.status : undefined;
            // Ambiguous transport failures (network loss, 5xx) may have
            // committed and consumed the one-use grant; retrying then
            // fails against the new state instead of confirming the
            // outcome. Reload status first and render the committed
            // result when it matches, mirroring the provider-backed
            // activation reconcile.
            if (failed === undefined || failed >= 500) {
                try {
                    const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
                    const live = (current.data as { data?: { status?: unknown; generation?: unknown; pendingCodeId?: unknown } }).data;
                    if (submittedMode === 'activate' && live?.status === 'active' && expectedGeneration !== null && live.generation === expectedGeneration) {
                        setPwMode(null); setPassword(''); setPwOld(''); setPwCode(''); setPwPendingId(null); setPwExpiresAt(null);
                        await loadStatus();
                        await refreshUser().catch(() => undefined);
                        return;
                    }
                    if (submittedMode === 'remove' && live?.status === 'unconfigured') {
                        setPwMode(null); setPassword(''); setPwOld(''); setPwCode(''); setPwPendingId(null); setPwExpiresAt(null);
                        await loadStatus();
                        await refreshUser().catch(() => undefined);
                        return;
                    }
                    if (submittedMode === 'generate' && live?.status === 'pending' && typeof live.pendingCodeId === 'string' && live.pendingCodeId !== priorPendingId) {
                        // A code was created but its one-time display is
                        // lost with the response: sync the pending view
                        // underneath and guide back to cancel-and-regenerate
                        // instead of a dead activate.
                        await loadStatus();
                        setFormError('A new code was created but its response was lost, so the code cannot be shown again. Go back, cancel the pending code, and generate a new one.');
                        return;
                    }
                } catch { /* fall through to the failure mapping below */ }
            }
            setFormError(failed === 401 ? 'Current password is incorrect.' : failed === 403 ? 'This account has no password. Use school sign-in instead.' : 'Password confirmation failed. Check the entries and try again.');
        } finally { setBusy(false); }
    };
    // Linking confirms the new school sign-in against this signed-in
    // account, so passwordless owners use the same Microsoft fresh proof as
    // unlinking instead of a password they do not have. The completion page
    // continues the link against the waiting tab handoff, so this must run
    // in the tab showing the link prompt: session storage is per-tab.
    const beginLink = async () => {
        if (linkBusy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setLinkBusy(true); setLinkError(null);
        try {
            const r = await studentSsoSessionApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'link' });
            const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl;
            if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid');
            window.location.assign(url);
        } catch { setLinkBusy(false); setLinkError('School sign-in confirmation could not start. Make sure a school sign-in is waiting on the link prompt in this tab; accounts without a linked Microsoft sign-in can link by following the sign-in prompts instead.'); }
    };
    const beginUnlink = async (target: LinkedIdentity) => {
        if (unlinkBusy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setUnlinkBusy(true); setUnlinkError(null);
        try {
            const r = await studentSsoSessionApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'unlink', targetIdentityId: target.id });
            const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl;
            if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid');
            window.location.assign(url);
        } catch { setUnlinkBusy(false); setUnlinkError('School sign-in confirmation could not start. Try again or use your password.'); }
    };
    const submitUnlinkPassword = async () => {
        const session = getSessionSnapshot(); if (!session.accessToken || unlinkBusy || !unlinkTarget || !unlinkPassword) return;
        setUnlinkBusy(true); setUnlinkError(null);
        // Same pre-refresh as recovery-code password proofs: the unlink
        // proof uses the non-refreshing client, so a stale token would 401
        // before the password is checked and misreport as "incorrect".
        let headers: { Authorization: string };
        try {
            headers = { Authorization: `Bearer ${await refreshSessionAccessToken()}` };
        } catch {
            setUnlinkBusy(false);
            setUnlinkError('Your session expired. Sign in again and retry.');
            return;
        }
        const targetId = unlinkTarget.id;
        try {
            const reauth = await studentSsoApiClient.post('/auth/student/sso/reauth', { password: unlinkPassword, purpose: 'unlink', targetIdentityId: targetId }, { headers });
            const g = (reauth.data as { data?: { grantId?: unknown; grantSecret?: unknown } }).data;
            if (!g || typeof g.grantId !== 'string' || typeof g.grantSecret !== 'string') throw new Error('invalid grant');
            const response = await studentSsoSessionApiClient.post(`/auth/student/sso/identities/${targetId}/unlink`, { reauthGrant: { grantId: g.grantId, grantSecret: g.grantSecret } });
            const data = (response.data as { success?: unknown; data?: unknown })?.success === true ? (response.data as { data?: unknown }).data as { unlinked?: unknown; sessionRevoked?: unknown } : null;
            if (!data || data.unlinked !== true || typeof data.sessionRevoked !== 'boolean') throw new Error('invalid unlink');
            // The server clears the session only when the removed identity
            // issued it; drop local tokens exactly then, before rendering.
            if (data.sessionRevoked) { clearTokens(); setSignedOut(true); return; }
            setUnlinkTarget(null); setUnlinkPassword(''); await loadIdentities();
        } catch (cause: unknown) {
            const failed = axios.isAxiosError(cause) ? cause.response : undefined;
            // Ambiguous transport failures (network loss, 5xx) may have
            // committed: the grant is then consumed and retrying cannot
            // confirm the outcome. Reload before reporting failure — a
            // missing target means the removal landed. The 200 also proves
            // the session survived; a server-cleared session 401s through
            // the session client's global expired-session handling instead.
            if (!failed || failed.status >= 500) {
                try {
                    const current = await studentSsoSessionApiClient.get('/auth/student/sso/identities');
                    const live = parseIdentities((current.data as { data?: unknown }).data);
                    if (live && !live.some((identity) => identity.id === targetId)) {
                        setIdentities(live); setIdentitiesError(null);
                        setUnlinkTarget(null); setUnlinkPassword('');
                        return;
                    }
                } catch (inner: unknown) {
                    // A 401 here is the committed outcome with the session
                    // revoked by the removed identity: the proof token was
                    // pre-refreshed seconds ago, so an independently
                    // expired session is not the explanation. Override the
                    // interceptor's queued generic redirect with the
                    // signed-out removal notice, mirroring the completion
                    // page — the last location write wins.
                    if (axios.isAxiosError(inner) && inner.response?.status === 401) {
                        clearTokens();
                        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                        window.location.assign('/auth/student/login?error=unlinked_signed_out');
                        return;
                    }
                    /* other reload failures fall through below */
                }
            }
            const code = (failed?.data as { error?: { code?: unknown } } | undefined)?.error?.code;
            setUnlinkError(failed?.status === 409 && code === 'SSO_LAST_LOGIN_METHOD' ? 'This is the last sign-in method. Link another school sign-in first.' : failed?.status === 409 && code === 'SSO_LAST_PROOF_METHOD' ? 'This Microsoft sign-in is needed for security confirmations. Link another Microsoft sign-in first.' : failed?.status === 401 ? 'Current password is incorrect.' : failed?.status === 403 ? 'This account has no password. Use school sign-in instead.' : 'Removal failed. Try again.');
        } finally { setUnlinkBusy(false); }
    };
    // No early return on recovery-status failure: identity listing,
    // password reauthentication, and unlinking stay available without the
    // recovery service, so the recovery section reports its own outage
    // inline while school sign-in controls render independently below.
    if (pwMode === 'display') return pwExpired
        ? <AuthShell role="student" title="Pending code expired" subtitle="The activation deadline passed." footer={null}><p role="alert">This pending code expired before activation and cannot recover your account. Start setup again for a fresh code.</p><Button type="button" onClick={() => { setPwMode(null); setPwCode(''); setPwPendingId(null); setPwExpiresAt(null); }} className="mt-5 w-full rounded-full">Back to account security</Button></AuthShell>
        : <AuthShell role="student" title="Save your recovery code" subtitle="Shown once. It will not be displayed again." footer={null}><p role="status" className="break-all rounded-2xl border px-4 py-3 text-left font-mono text-sm">{pwCode}</p>{Number.isNaN(pwDeadlineMs) ? null : <p role="timer" className="mt-3 text-left text-sm">Activate this code within {formatPendingRemaining(pwDeadlineMs, now + pwSkewMs)}.</p>}<Button type="button" onClick={() => { setPwCode(''); setPwMode('activate'); }} className="mt-5 w-full rounded-full">I saved my code</Button></AuthShell>;
    if (pwMode) return <AuthShell role="student" title="Confirm with your password" subtitle={pwMode === 'generate' ? 'Password confirmation for a new code.' : pwMode === 'activate' ? 'Password confirmation to activate the saved code.' : 'Password confirmation to remove the code.'} footer={null}>
        {pwMode === 'activate' && !Number.isNaN(pwDeadlineMs) ? <p role="timer" className="mb-3 text-left text-sm">Activate this code within {formatPendingRemaining(pwDeadlineMs, now + pwSkewMs)}.</p> : null}
        {pwMode === 'activate' && pwExpired ? <p role="alert" className="mb-3 text-sm text-red-600">This pending code expired before activation. Go back and start setup again for a fresh code.</p> : null}
        <div className="space-y-3"><label className="block text-left text-sm" htmlFor="recovery-password">Current password<input id="recovery-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>
        {pwMode === 'activate' ? <label className="block text-left text-sm" htmlFor="recovery-code-confirm">Re-enter saved recovery code<input id="recovery-code-confirm" value={pwCode} onChange={e => setPwCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label> : null}
        <label className="block text-left text-sm" htmlFor="recovery-code-current">{pwMode === 'remove' ? 'Current recovery code' : 'Current recovery code (required when replacing)'}<input id="recovery-code-current" value={pwOld} onChange={e => setPwOld(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label></div>
        {formError ? <p role="alert" className="mt-3 text-sm text-red-600">{formError}</p> : null}
        {pwMode === 'activate' && pwExpired ? null : <Button type="button" onClick={submitPassword} disabled={busy} className="mt-5 w-full rounded-full">{pwMode === 'generate' ? 'Generate code' : pwMode === 'activate' ? 'Activate code' : 'Remove code'}</Button>}
        <Button type="button" variant="outline" onClick={() => { setPwMode(null); setFormError(null); }} disabled={busy} className="mt-2 w-full rounded-full">Back</Button>
    </AuthShell>;
    const methodToggle = <Button type="button" variant="ghost" onClick={() => setPwPreferred(!pwPreferred)} disabled={busy} className="w-full rounded-full">{pwPreferred ? 'Use school sign-in instead' : 'Use your password instead'}</Button>;
    return <AuthShell role="student" title="Account security" subtitle="Optional recovery-code setup." footer={null}>
        <p className="text-left text-sm text-slate-600">Confirm your identity, save your code, then confirm your identity again to activate it. The code is shown once and is never stored in this browser, emailed, or placed in a URL. Recovery also needs access to your school mailbox; it does not promise permanent access.</p>
        {schoolError ? <p role="alert" className="mt-3 text-left text-sm text-red-600">{schoolError}</p> : null}
        {status === 'active' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A recovery code is active. Replacing or removing it requires the current code and fresh confirmation.</p><Button type="button" onClick={() => pwPreferred ? startPassword('generate') : begin()} disabled={busy} className="w-full rounded-full">Replace recovery code</Button><Button type="button" variant="outline" onClick={() => pwPreferred ? startPassword('remove') : beginRemove()} disabled={busy} className="w-full rounded-full">Remove recovery code</Button>{methodToggle}</div> : status === 'pending' ? pendingExpired
            ? <div className="mt-4 space-y-3"><p role="alert" className="text-left text-sm">This pending code expired before activation and cannot recover your account. Refresh for current status, then start setup again for a fresh code.</p><Button type="button" onClick={() => { const live = getSessionSnapshot(); if (live.accessToken) void loadStatus(); }} disabled={busy} className="w-full rounded-full">Refresh status</Button>{methodToggle}</div>
            : <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A pending code exists but cannot recover your account. Confirm your identity again before it expires.</p>{Number.isNaN(pendingDeadlineMs) ? null : <p role="timer" className="text-left text-sm">Activate this code within {formatPendingRemaining(pendingDeadlineMs, now + skewMs)}.</p>}{passwordOnlyEnrollment ? <p role="status" className="text-left text-sm">After account recovery, enroll the replacement code with your password. School sign-in cannot be used for this enrollment.</p> : null}<Button type="button" onClick={() => (passwordOnlyEnrollment || pwPreferred) ? startPassword('activate') : beginActivation()} disabled={busy || !pendingCodeId} className="w-full rounded-full">Confirm identity to activate saved code</Button><Button type="button" variant="outline" onClick={cancelPending} disabled={busy || !pendingCodeId} className="w-full rounded-full">Cancel pending code</Button>{passwordOnlyEnrollment ? null : methodToggle}</div> : status === 'unavailable' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">Recovery-code setup is unavailable. Sign in again and retry. If school sign-in is unavailable, use recovery only if you already saved a recovery code.</p><Link className="text-left text-sm text-primary underline" href="/auth/student/recovery">Account recovery</Link></div> : <div className="mt-5 space-y-2">{passwordOnlyEnrollment ? <p role="status" className="text-left text-sm">After account recovery, enroll the replacement code with your password. School sign-in cannot be used for this enrollment.</p> : null}<Button type="button" onClick={() => (passwordOnlyEnrollment || pwPreferred) ? startPassword('generate') : begin()} disabled={busy || status === 'loading'} className="w-full rounded-full">{busy ? ((passwordOnlyEnrollment || pwPreferred) ? 'Working…' : 'Redirecting…') : 'Confirm identity to generate a code'}</Button>{passwordOnlyEnrollment ? null : methodToggle}</div>}
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
                <p className="text-sm text-slate-600">To link a new school sign-in, first sign out and sign in with that school account until it shows the link prompt, keeping the tab open. Then, signed in to this account, return to the tab showing the link prompt, open Account security there, and confirm below with school sign-in. Accounts with a password can also link by following the sign-in prompts.</p>
                {linkError ? <p role="alert" className="mt-2 text-sm text-red-600">{linkError}</p> : null}
                <Button type="button" variant="outline" onClick={() => void beginLink()} disabled={linkBusy} className="mt-3 w-full rounded-full">Link a school sign-in</Button>
            </div>}
        </div>
    </AuthShell>;
}
