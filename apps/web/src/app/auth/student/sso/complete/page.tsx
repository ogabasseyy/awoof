/**
 * Student SSO completion: finishes the tab-bound attempt after the provider
 * redirects back. Successful linked logins commit exactly one session;
 * unlinked identities stay signed out with an explicit pending state, and
 * every failure redirects to the password login with the safe error taxonomy
 * only — never a secret, email, or upstream message in the URL.
 */

'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { publicApiClient, studentSsoApiClient } from '@/lib/api-client';
import { clearTokens, getSessionSnapshot } from '@/lib/auth';
import { resolveStudentReturn } from '@/lib/student-return';
import {
    clearSsoAttempt,
    clearSsoHandoff,
    isSsoAttemptLive,
    parseSsoFinishResponse,
    parseSsoLinkResponse,
    parseSsoRestart,
    parseSsoReauthFinish,
    readSsoAttempt,
    readSsoHandoff,
    saveSsoHandoff,
    serverSkewSince,
    ssoAttemptMatches,
    ssoFailureLoginPath,
    ssoPostLoginDestination,
    type LoginErrorCode,
    type SsoAttemptRecord,
} from '@/lib/student-login-flow';

function statusOf(cause: unknown): number | undefined {
    return axios.isAxiosError(cause) ? cause.response?.status : undefined;
}

function bodyOf(cause: unknown): unknown {
    return axios.isAxiosError(cause) ? cause.response?.data : undefined;
}

type RecoveryIntent = { purpose: 'recovery_code_generate' | 'recovery_code_activate'; pendingCodeId?: string };
const RECOVERY_INTENT_KEY = 'awoof.recovery.intent.v1.tab';
function readRecoveryIntent(): RecoveryIntent | null {
    try {
        const raw = sessionStorage.getItem(RECOVERY_INTENT_KEY); if (!raw) return null;
        const value = JSON.parse(raw) as Partial<RecoveryIntent>;
        return (value.purpose === 'recovery_code_generate' || value.purpose === 'recovery_code_activate')
            && (value.pendingCodeId === undefined || typeof value.pendingCodeId === 'string') ? value as RecoveryIntent : null;
    } catch { return null; }
}
function clearRecoveryIntent(): void { try { sessionStorage.removeItem(RECOVERY_INTENT_KEY); } catch { /* no browser persistence available */ } }

function formatPendingRemaining(deadlineMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function RecoveryReauthComplete({ attemptId }: { attemptId: string }) {
    const { refreshUser } = useAuth();
    const [status, setStatus] = useState<'checking' | 'generate' | 'display' | 'activate' | 'remove' | 'failed' | 'active' | 'removed' | 'link_unavailable' | 'unlinked' | 'unlinked_signed_out' | 'last_method'>('checking');
    const [code, setCode] = useState(''); const [oldCode, setOldCode] = useState(''); const [needsOldCode, setNeedsOldCode] = useState(false); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null); const [pendingExpiresAt, setPendingExpiresAt] = useState<string | null>(null); const [expectedGeneration, setExpectedGeneration] = useState<number | null>(null); const [grant, setGrant] = useState<{ grantId: string; grantSecret: string } | null>(null); const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false); const started = useRef(false); const actionBusy = useRef(false);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    // The ten-minute activation deadline is displayed and enforced in the
    // UI: at expiry the page swaps to an explicit restart state instead of
    // letting activation degrade into a generic failure. The skew sampled
    // with each deadline keeps a fast device clock from expiring a live
    // code early.
    const [skewMs, setSkewMs] = useState(0);
    const pendingDeadlineMs = pendingExpiresAt ? Date.parse(pendingExpiresAt) : NaN;
    const pendingExpired = (status === 'display' || status === 'activate') && pendingExpiresAt !== null && !Number.isNaN(pendingDeadlineMs) && pendingDeadlineMs <= now + skewMs;
    useEffect(() => {
        if (started.current) return; started.current = true;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('failed'); return; }
        const accessToken = session.accessToken;
        void studentSsoApiClient.post('/auth/student/sso/reauth/finish', { attemptId }, { headers: { Authorization: `Bearer ${accessToken}` } }).then(async response => {
            const grant = parseSsoReauthFinish(response.data); if (!grant) throw new Error('invalid grant');
            if (grant.purpose === 'link' || grant.purpose === 'unlink') { await continueIdentity({ grantId: grant.grantId, grantSecret: grant.grantSecret, purpose: grant.purpose, targetIdentityId: grant.targetIdentityId }, accessToken); return; }
            if (grant.purpose === 'recovery_code_generate') {
                clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
                if (grant.activeCodeGeneration !== null) { setStatus('generate'); return; }
                const generated = await studentSsoApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: { grantId: grant.grantId, grantSecret: grant.grantSecret } }, { headers: { Authorization: `Bearer ${session.accessToken}` } });
                const data = (generated.data as { data?: { pendingCodeId?: unknown; code?: unknown; expiresAt?: unknown; serverNow?: unknown } }).data;
                if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error('invalid code');
                setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code);
                setPendingExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null);
                setSkewMs(serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null));
                setStatus('display'); return;
            }
            if (grant.purpose === 'recovery_code_remove') { clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret }); setStatus('remove'); return; }
            if (grant.purpose !== 'recovery_code_activate' || !grant.pendingCodeId) throw new Error('missing pending');
            clearRecoveryIntent();
            // The user re-enters the value here after the second fresh proof; it was never persisted through the redirect.
            // A replacement additionally requires the current code the backend still enforces.
            setPendingCodeId(grant.pendingCodeId); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
            setNeedsOldCode(grant.activeCodeGeneration !== null);
            try {
                const current = await studentSsoApiClient.get('/auth/student/sso/recovery-code', { headers: { Authorization: `Bearer ${accessToken}` } });
                const live = (current.data as { data?: { status?: unknown; generation?: unknown; pendingCodeId?: unknown; pendingExpiresAt?: unknown; serverNow?: unknown } }).data;
                // The expected generation binds ambiguous-activation
                // reconciliation: success requires the active generation to
                // match the pending one we are activating, not merely any
                // active code (an expired replacement falls back to the old
                // generation, which must not read as our success).
                if (live?.status === 'pending' && live.pendingCodeId === grant.pendingCodeId && typeof live.pendingExpiresAt === 'string') {
                    setPendingExpiresAt(live.pendingExpiresAt);
                    setSkewMs(serverSkewSince(typeof live.serverNow === 'string' && !Number.isNaN(Date.parse(live.serverNow)) ? live.serverNow : null));
                    setExpectedGeneration(typeof live.generation === 'number' ? live.generation : null);
                }
            } catch { /* deadline display is best-effort; activation still enforces expiry server-side */ }
            setStatus('activate');
        }).catch(() => { clearRecoveryIntent(); setStatus('failed'); });
    }, [attemptId]);
    const continueIdentity = async (grant: { grantId: string; grantSecret: string; purpose: 'link' | 'unlink'; targetIdentityId: string | null }, accessToken: string) => {
        const auth = { grantId: grant.grantId, grantSecret: grant.grantSecret };
        if (grant.purpose === 'link') {
            const handoff = readSsoHandoff(tabStorage());
            if (!handoff) { setStatus('link_unavailable'); return; }
            try {
                const response = await studentSsoApiClient.post('/auth/student/sso/link', { handoffId: handoff.handoffId, handoffSecret: handoff.handoffSecret, reauthGrant: auth }, { headers: { Authorization: `Bearer ${accessToken}` } });
                if (parseSsoLinkResponse(response.status, response.data)?.kind !== 'linked') throw new Error('not linked');
                clearSsoHandoff(tabStorage()); window.location.assign(handoff.returnPath); return;
            } catch (cause: unknown) {
                const result = parseSsoLinkResponse(statusOf(cause), bodyOf(cause));
                // Only terminal mismatch/restart outcomes spend the handoff.
                // Ambiguous failures (network loss, 5xx) keep the tab's copy
                // so the live server-side handoff stays retryable with a
                // fresh grant, mirroring the onboarding link flow.
                if (!result || result.kind === 'linked') { setStatus('failed'); return; }
                clearSsoHandoff(tabStorage());
                setStatus('link_unavailable'); return;
            }
        }
        if (!grant.targetIdentityId) { setStatus('failed'); return; }
        try {
            const response = await studentSsoApiClient.post(`/auth/student/sso/identities/${grant.targetIdentityId}/unlink`, { reauthGrant: auth }, { headers: { Authorization: `Bearer ${accessToken}` } });
            const data = (response.data as { success?: unknown; data?: unknown })?.success === true ? (response.data as { data?: unknown }).data as { unlinked?: unknown; sessionRevoked?: unknown } : null;
            if (!data || data.unlinked !== true || typeof data.sessionRevoked !== 'boolean') throw new Error('invalid unlink');
            // The server clears the session only when the removed identity
            // issued it; drop local tokens exactly then, before rendering.
            if (data.sessionRevoked) clearTokens();
            setStatus(data.sessionRevoked ? 'unlinked_signed_out' : 'unlinked');
        } catch (cause: unknown) {
            const body = bodyOf(cause) as { error?: { code?: unknown } } | undefined;
            if (statusOf(cause) === 409 && body?.error?.code === 'SSO_LAST_LOGIN_METHOD') { setStatus('last_method'); return; }
            setStatus('failed');
        }
    };
    const activate = async () => {
        const session = getSessionSnapshot(); if (actionBusy.current || !grant || !pendingCodeId || !session.accessToken || !code || (needsOldCode && !oldCode)) return; actionBusy.current = true; setBusy(true);
        const pendingId = pendingCodeId;
        const reconcile = async (): Promise<boolean> => {
            try {
                const current = await studentSsoApiClient.get('/auth/student/sso/recovery-code', { headers: { Authorization: `Bearer ${session.accessToken}` } });
                const live = (current.data as { data?: { status?: unknown; generation?: unknown; pendingCodeId?: unknown; pendingExpiresAt?: unknown; serverNow?: unknown } }).data;
                // An ambiguous transport failure may have committed: the
                // grant is then consumed and retrying cannot succeed. Only
                // the expected pending generation reading back as active
                // proves ours activated; any other active generation (an
                // expired replacement falling back to the old code, a
                // concurrent flow) keeps the form with its error.
                if (live?.status === 'active' && expectedGeneration !== null && live.generation === expectedGeneration) { setGrant(null); setCode(''); setOldCode(''); setStatus('active'); await refreshUser().catch(() => undefined); return true; }
                if (live?.status === 'pending' && live.pendingCodeId === pendingId && typeof live.pendingExpiresAt === 'string') {
                    setPendingExpiresAt(live.pendingExpiresAt);
                    setSkewMs(serverSkewSince(typeof live.serverNow === 'string' && !Number.isNaN(Date.parse(live.serverNow)) ? live.serverNow : null));
                }
            } catch { /* reconciliation failed; fall through to the generic error */ }
            return false;
        };
        try {
            await studentSsoApiClient.post('/auth/student/sso/recovery-code/activate', { reauthGrant: grant, pendingCodeId: pendingId, code, ...(needsOldCode ? { oldCode } : {}) }, { headers: { Authorization: `Bearer ${session.accessToken}` } });
            setGrant(null); setCode(''); setOldCode(''); setStatus('active'); await refreshUser().catch(() => undefined);
        } catch (cause: unknown) {
            const response = axios.isAxiosError(cause) ? cause.response : undefined;
            // Deterministic rejections keep the form with its error; only
            // response-loss/network failures reconcile against status.
            if ((!response || response.status >= 500) && await reconcile()) return;
            setError('This confirmation could not be completed. If the pending code expired, restart setup.');
        } finally { actionBusy.current = false; setBusy(false); }
    };
    const generateReplacement = async () => {
        const session = getSessionSnapshot(); if (actionBusy.current || !grant || !session.accessToken || !code) return; actionBusy.current = true; setBusy(true);
        try { const r = await studentSsoApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: grant, oldCode: code }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const data = (r.data as { data?: { pendingCodeId?: unknown; code?: unknown; expiresAt?: unknown; serverNow?: unknown } }).data; if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error(); setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code); setPendingExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null); setSkewMs(serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null)); setStatus('display'); } catch { setError('The current recovery code could not be confirmed.'); } finally { actionBusy.current = false; setBusy(false); }
    };
    const remove = async () => { const session = getSessionSnapshot(); if (actionBusy.current || !grant || !session.accessToken || !code) return; actionBusy.current = true; setBusy(true); try { await studentSsoApiClient.post('/auth/student/sso/recovery-code/remove', { reauthGrant: grant, oldCode: code }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); setGrant(null); setCode(''); setStatus('removed'); } catch { setError('The current recovery code could not be confirmed.'); } finally { actionBusy.current = false; setBusy(false); } };
    if (status === 'generate') return <AuthShell role="student" title="Replace recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="old-recovery-code">Current recovery code<input id="old-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button disabled={busy} className="mt-5 w-full rounded-full" onClick={generateReplacement}>Generate replacement code</Button></AuthShell>;
    if (pendingExpired) return <AuthShell role="student" title="Pending code expired" subtitle="The activation deadline passed." footer={null}><p role="alert">This pending code expired before activation and cannot recover your account. Start setup again for a fresh code.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'display') return <AuthShell role="student" title="Save your recovery code" subtitle="It will not be shown again." footer={null}><p role="alert" className="rounded-xl bg-amber-50 p-3 break-all font-mono text-left">{code}</p>{Number.isNaN(pendingDeadlineMs) ? null : <p role="timer" className="mt-3 text-left text-sm">Activate this code within {formatPendingRemaining(pendingDeadlineMs, now + skewMs)}.</p>}<p className="mt-3 text-left text-sm">Save this code somewhere secure. It is not stored in this browser, sent by email, or added to a URL. Then return to Account security and confirm your identity again to activate it.</p><Button className="mt-5 w-full rounded-full" onClick={() => { if (pendingCodeId) try { sessionStorage.setItem(RECOVERY_INTENT_KEY, JSON.stringify({ purpose: 'recovery_code_activate', pendingCodeId })); } catch { /* security page reports unavailable */ } setCode(''); window.location.href = '/student/security'; }}>I saved my code</Button></AuthShell>;
    if (status === 'activate') return <AuthShell role="student" title="Confirm your recovery code" subtitle="Fresh identity confirmation completed." footer={null}>{Number.isNaN(pendingDeadlineMs) ? null : <p role="timer" className="mb-3 text-left text-sm">Activate this code within {formatPendingRemaining(pendingDeadlineMs, now + skewMs)}.</p>}<label className="block text-left text-sm" htmlFor="recovery-code-confirm">Re-enter saved recovery code<input id="recovery-code-confirm" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{needsOldCode ? <label className="mt-3 block text-left text-sm" htmlFor="recovery-code-current">Current recovery code<input id="recovery-code-current" value={oldCode} onChange={e => setOldCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label> : null}{error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}<Button disabled={busy} className="mt-5 w-full rounded-full" onClick={activate}>Activate recovery code</Button></AuthShell>;
    if (status === 'remove') return <AuthShell role="student" title="Remove recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="remove-recovery-code">Current recovery code<input id="remove-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button disabled={busy} className="mt-5 w-full rounded-full" onClick={remove}>Remove recovery code</Button></AuthShell>;
    if (status === 'active') return <AuthShell role="student" title="Recovery code active" subtitle="Your optional recovery setup is complete." footer={null}><p role="status">Keep your saved code secure. It is required with your school mailbox for independent password recovery.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/marketplace">Continue</Link></Button></AuthShell>;
    if (status === 'removed') return <AuthShell role="student" title="Recovery code removed" subtitle="Recovery is now unconfigured." footer={null}><p role="status">The saved code was revoked and can no longer recover this account. Set up a new code from Account security if you still want recovery.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'link_unavailable') return <AuthShell role="student" title="School sign-in link unavailable" subtitle="This sign-in can no longer be linked." footer={null}><p role="status">The pending school sign-in expired or was already used. Restart school sign-in and try again.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Back to sign-in</Link></Button></AuthShell>;
    if (status === 'unlinked') return <AuthShell role="student" title="Sign-in method removed" subtitle="The school sign-in was disconnected." footer={null}><p role="status">That school sign-in can no longer access this account.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'unlinked_signed_out') return <AuthShell role="student" title="Sign-in method removed" subtitle="You have been signed out." footer={null}><p role="status">The removed sign-in had issued this session, so the local sign-in was cleared. That school sign-in can no longer access this account.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Back to sign-in</Link></Button></AuthShell>;
    if (status === 'last_method') return <AuthShell role="student" title="Cannot remove the last sign-in method" subtitle="Keep another way to sign in first." footer={null}><p role="status">Removing this sign-in would lock the account. Link another school sign-in or set a password first.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    return <AuthShell role="student" title="Security confirmation unavailable" subtitle="The fresh confirmation expired or was interrupted." footer={null}><p role="status">No recovery code was activated. Start the optional setup again.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
}

type CompleteView =
    | { kind: 'checking' }
    | { kind: 'link_required'; provider: 'google' | 'microsoft' }
    | { kind: 'already_signed_in'; continuePath: string }
    | { kind: 'discarded' };

function tabStorage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

function failToLogin(code: LoginErrorCode, returnPath: string | null): void {
    clearSsoAttempt(tabStorage());
    window.location.href = ssoFailureLoginPath(code, returnPath, window.location.origin);
}

function StudentSsoCompleteInner() {
    const search = useSearchParams();
    const { completeSsoLogin } = useAuth();
    const [view, setView] = useState<CompleteView>({ kind: 'checking' });
    const [signupOffer, setSignupOffer] = useState<'checking' | 'available' | 'hidden'>('checking');
    const started = useRef(false);

    const reauthAttempt = search.get('reauth');

    useEffect(() => {
        if (reauthAttempt) return;
        if (started.current) return;
        started.current = true;
        const attemptId = search.get('attempt');
        const outcome = search.get('outcome');
        const storage = tabStorage();
        const record: SsoAttemptRecord | null = readSsoAttempt(storage);

        if (outcome === 'connection_not_completed') {
            failToLogin('sso_not_completed', record?.returnPath ?? null);
            return;
        }
        if (outcome !== null) {
            failToLogin('sso_unavailable', record?.returnPath ?? null);
            return;
        }
        const snapshot = getSessionSnapshot();
        if (snapshot.accessToken || snapshot.refreshToken) {
            // Another account signed in on this tab (or never signed out). The
            // late finish is discarded before any attempt check; nothing is
            // replaced.
            clearSsoAttempt(storage);
            if (record && snapshot.generation === record.generation) {
                setView({
                    kind: 'already_signed_in',
                    continuePath: resolveStudentReturn(record.returnPath, window.location.origin),
                });
            } else {
                setView({ kind: 'discarded' });
            }
            return;
        }
        if (!attemptId || !record || !ssoAttemptMatches(record, attemptId, snapshot.generation)) {
            failToLogin('sso_expired', record?.returnPath ?? null);
            return;
        }
        if (!isSsoAttemptLive(record, Date.now())) {
            failToLogin('sso_expired', record.returnPath);
            return;
        }

        const startedGeneration = snapshot.generation;
        const finish = async (): Promise<void> => {
            let response;
            try {
                response = await studentSsoApiClient.post('/auth/student/sso/finish', {
                    attemptId: record.attemptId,
                    finishSecret: record.finishSecret,
                });
            } catch (cause: unknown) {
                const status = axios.isAxiosError(cause) ? cause.response?.status : undefined;
                const body = axios.isAxiosError(cause) ? cause.response?.data : undefined;
                if (parseSsoRestart(status, body)) {
                    // The server refuses to overwrite a session that appeared
                    // while this attempt was in flight: surface the surviving
                    // concurrent sign-in instead of expiring to the login page.
                    const latest = getSessionSnapshot();
                    if (latest.accessToken || latest.refreshToken) {
                        clearSsoAttempt(storage);
                        if (latest.generation === record.generation) {
                            setView({
                                kind: 'already_signed_in',
                                continuePath: resolveStudentReturn(record.returnPath, window.location.origin),
                            });
                        } else {
                            setView({ kind: 'discarded' });
                        }
                        return;
                    }
                    failToLogin('sso_expired', record.returnPath);
                    return;
                }
                failToLogin(status === 401 ? 'sso_not_completed' : 'sso_unavailable', record.returnPath);
                return;
            }
            const finished = parseSsoFinishResponse(response.data);
            if (!finished) {
                failToLogin('sso_unavailable', record.returnPath);
                return;
            }
            if (finished.kind === 'link_required') {
                // The attempt is cleared below, so the handoff carries the
                // validated return path forward for post-link continuation.
                const kept = saveSsoHandoff(storage, {
                    handoffId: finished.handoffId,
                    handoffSecret: finished.handoffSecret,
                    expiresAt: finished.expiresAt,
                    returnPath: record.returnPath,
                    serverSkewMs: record.serverSkewMs,
                });
                clearSsoAttempt(storage);
                if (!kept) {
                    failToLogin('sso_unavailable', record.returnPath);
                    return;
                }
                // Unlinked identities stay signed out: no session is stored.
                setView({ kind: 'link_required', provider: finished.provider });
                return;
            }
            const committed = await completeSsoLogin(startedGeneration, response.data);
            clearSsoAttempt(storage);
            clearSsoHandoff(storage);
            if (!committed.committed) {
                setView({ kind: 'discarded' });
                return;
            }
            window.location.href = ssoPostLoginDestination({
                studentAssurance: committed.studentAssurance,
                assuranceStatus: committed.assuranceStatus,
                returnPath: record.returnPath,
                origin: window.location.origin,
            });
        };
        void finish();
    }, [search, completeSsoLogin, reauthAttempt]);

    const linkProvider = view.kind === 'link_required' ? view.provider : null;
    useEffect(() => {
        if (linkProvider === null || signupOffer !== 'checking') return;
        let cancelled = false;
        // Provider-scoped: the server reports availability only when the
        // provider that produced this unknown identity is still enabled.
        void publicApiClient.get(`/auth/student/sso/signup/availability?provider=${linkProvider}`)
            .then(r => { const data = (r.data as { success?: unknown; data?: unknown })?.success === true ? (r.data as { data?: unknown }).data : null; if (!cancelled) setSignupOffer(data !== null && typeof data === 'object' && (data as { available?: unknown }).available === true ? 'available' : 'hidden'); })
            .catch(() => { if (!cancelled) setSignupOffer('hidden'); });
        return () => { cancelled = true; };
    }, [linkProvider, signupOffer]);

    if (reauthAttempt) return <RecoveryReauthComplete attemptId={reauthAttempt} />;

    if (view.kind === 'link_required') {
        return (
            <AuthShell
                role="student"
                title="Link your school account"
                subtitle="This school sign-in is not linked to an Awoof account yet."
                footer={null}
            >
                <p role="status" className="text-left text-sm text-slate-600">
                    You are still signed out. Sign in with your password{signupOffer === 'available' ? ', or create an account,' : ''} to link this school
                    sign-in. Linking never matches accounts by email alone. Without a password, sign in with an existing school account in another tab,
                    then return to this tab and confirm linking from Account security here: the pending sign-in lives in this tab only.
                </p>
                <div className="mt-5 space-y-2">
                    <Button type="button" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/auth/student/login?redirect=%2Fauth%2Fstudent%2Fsso%2Fonboarding">
                            Sign in with your password
                        </Link>
                    </Button>
                    {signupOffer === 'available' ? <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/auth/student/sso/onboarding?mode=signup">Create a passwordless account</Link>
                    </Button> : null}
                </div>
            </AuthShell>
        );
    }

    if (view.kind === 'already_signed_in') {
        return (
            <AuthShell role="student" title="Already signed in" subtitle="This device already has a signed-in account." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    The school sign-in was discarded and nothing was replaced.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href={view.continuePath}>Continue</Link>
                </Button>
            </AuthShell>
        );
    }

    if (view.kind === 'discarded') {
        return (
            <AuthShell role="student" title="Sign-in discarded" subtitle="Another account signed in on this tab." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    Your school sign-in finished after another account signed in here, so it was discarded and nothing
                    was replaced.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href="/marketplace">Continue to marketplace</Link>
                </Button>
            </AuthShell>
        );
    }

    return (
        <AuthShell role="student" title="Completing school sign-in" subtitle="Checking student status." footer={null}>
            <p role="status" className="text-left text-sm text-slate-600">
                Checking student status… Your school may ask you to approve enrollment access next; follow its prompts.
            </p>
        </AuthShell>
    );
}

export default function StudentSsoCompletePage() {
    return (
        <Suspense fallback={<p role="status">Loading school sign-in…</p>}>
            <StudentSsoCompleteInner />
        </Suspense>
    );
}
