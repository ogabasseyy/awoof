/**
 * Student SSO completion: finishes the tab-bound attempt after the provider
 * redirects back. Successful linked logins commit exactly one session;
 * unlinked identities stay signed out with an explicit pending state, and
 * every failure redirects to the password login with the safe error taxonomy
 * only — never a secret, email, or upstream message in the URL.
 */

'use client';

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { MicrosoftCallbackShell } from '@/components/auth/MicrosoftCallbackShell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { publicApiClient, studentSsoApiClient, studentSsoSessionApiClient } from '@/lib/api-client';
import { clearTokens, getSessionSnapshot, subscribeSessionChanges } from '@/lib/auth';
import { STUDENT_SSO_ONBOARDING_RETURN_PATH, resolveStudentReturn } from '@/lib/student-return';
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

// A 409 whose error details flag retryable means the attempt is still
// redeeming upstream: the check must wait, never fail.
function isRetryableFinishConflict(cause: unknown): boolean {
    if (!axios.isAxiosError(cause) || cause.response?.status !== 409) return false;
    const details = (cause.response.data as { error?: { details?: unknown } })?.error?.details;
    return typeof details === 'object' && details !== null && (details as { retryable?: unknown }).retryable === true;
}

const RECOVERY_INTENT_KEY = 'awoof.recovery.intent.v1.tab';
function clearRecoveryIntent(): void { try { sessionStorage.removeItem(RECOVERY_INTENT_KEY); } catch { /* no browser persistence available */ } }

function formatPendingRemaining(deadlineMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function RecoveryReauthComplete({ attemptId, duplicate, unavailable }: { attemptId: string; duplicate: boolean; unavailable: boolean }) {
    const { refreshUser, user } = useAuth();
    // Another tab can replace the browser session while a grant or code
    // request is in flight. Fence by the browser-local session ID as well
    // as user ID: signing back into the same account is still a new session.
    const browserSessionId = useSyncExternalStore(
        subscribeSessionChanges,
        () => getSessionSnapshot().browserSessionId,
        () => null,
    );
    const accountGeneration = useRef(0);
    // Set before this component's own session-clearing unlink paths so the
    // layout effect below can tell an intentional sign-out from a foreign
    // session replacement.
    const intentionalSignOut = useRef(false);
    const loadedUserId = useRef<string | null | undefined>(undefined);
    const loadedBrowserSessionId = useRef<string | null | undefined>(undefined);
    const currentUserId = user?.id ?? null;
    const [status, setStatus] = useState<'checking' | 'waiting' | 'generate' | 'generate_ambiguous' | 'display' | 'activate' | 'remove' | 'failed' | 'active' | 'removed' | 'link_unavailable' | 'unlinked' | 'unlinked_signed_out' | 'last_method' | 'last_proof_method' | 'link_ambiguous'>(unavailable ? 'failed' : 'checking');
    const [code, setCode] = useState(''); const [oldCode, setOldCode] = useState(''); const [needsOldCode, setNeedsOldCode] = useState(false); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null); const [pendingExpiresAt, setPendingExpiresAt] = useState<string | null>(null); const [expectedGeneration, setExpectedGeneration] = useState<number | null>(null); const [grant, setGrant] = useState<{ grantId: string; grantSecret: string } | null>(null); const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false); const started = useRef(false); const actionBusy = useRef(false); const finishInFlight = useRef(false); const waitingAutoTries = useRef(0);
    const [now, setNow] = useState(() => Date.now());
    useLayoutEffect(() => {
        if (intentionalSignOut.current && browserSessionId === null) {
            // Unlinking the identity that issued this session clears local
            // tokens on purpose: invalidate stragglers and drop held
            // secrets, but preserve the terminal signed-out removal state
            // instead of failing.
            intentionalSignOut.current = false;
            loadedUserId.current = currentUserId;
            loadedBrowserSessionId.current = browserSessionId;
            accountGeneration.current += 1;
            setGrant(null); setCode(''); setOldCode('');
            return;
        }
        // A non-null session here is a foreign replacement, not the
        // reconciliation request's expected 401 clear.
        if (intentionalSignOut.current) intentionalSignOut.current = false;
        const previousUserId = loadedUserId.current;
        const previousSessionId = loadedBrowserSessionId.current;
        if (previousUserId === currentUserId && previousSessionId === browserSessionId) return;
        loadedUserId.current = currentUserId;
        loadedBrowserSessionId.current = browserSessionId;
        // Initial mount and late user populate keep their state. Once a
        // non-null owner existed, either an account change or replacement
        // browser session invalidates captured responses and secrets before
        // the browser paints.
        const priorOwnerKnown = previousUserId != null || previousSessionId != null;
        if (!priorOwnerKnown || (previousUserId == null && previousSessionId === browserSessionId)) return;
        accountGeneration.current += 1;
        setGrant(null); setCode(''); setOldCode(''); setPendingCodeId(null);
        setPendingExpiresAt(null); setExpectedGeneration(null);
        setNeedsOldCode(false); setError(null); setBusy(false);
        actionBusy.current = false; finishInFlight.current = false; waitingAutoTries.current = 0;
        // A completed signed-out removal keeps its terminal state even if
        // a later foreign swap races the flag consumption above.
        if (status !== 'unlinked_signed_out') setStatus('failed');
    }, [browserSessionId, currentUserId, status]);
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

    const refreshPendingCodeStatus = async (expectedPendingId: string | null = pendingCodeId, generation = accountGeneration.current): Promise<boolean> => {
        if (!expectedPendingId) return false;
        const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
        if (generation !== accountGeneration.current) return false;
        const live = (current.data as { data?: { status?: unknown; generation?: unknown; pendingCodeId?: unknown; pendingExpiresAt?: unknown; serverNow?: unknown } }).data;
        if (live?.status !== 'pending' || live.pendingCodeId !== expectedPendingId || !Number.isSafeInteger(live.generation)
            || typeof live.pendingExpiresAt !== 'string' || Number.isNaN(Date.parse(live.pendingExpiresAt))) {
            setExpectedGeneration(null);
            return false;
        }
        setPendingExpiresAt(live.pendingExpiresAt);
        setSkewMs(serverSkewSince(typeof live.serverNow === 'string' && !Number.isNaN(Date.parse(live.serverNow)) ? live.serverNow : null));
        setExpectedGeneration(live.generation as number);
        return true;
    };
    const pendingExpired = (status === 'display' || status === 'activate') && pendingExpiresAt !== null && !Number.isNaN(pendingDeadlineMs) && pendingDeadlineMs <= now + skewMs;
    // The session client carries the reauth cookie and refreshes a
    // token that expired during the provider prompt instead of
    // collapsing the fresh proof into the failed view.
    const runFinish = () => {
        // The automatic backoff and manual button can fire in the same turn.
        // Only one caller may exchange the one-use proof; otherwise a losing
        // duplicate 409 can overwrite the continuation from the winner.
        if (finishInFlight.current) return;
        finishInFlight.current = true;
        const generation = accountGeneration.current;
        const stale = () => generation !== accountGeneration.current;
        void studentSsoSessionApiClient.post('/auth/student/sso/reauth/finish', { attemptId }).then(async response => {
            if (stale()) return;
            const grant = parseSsoReauthFinish(response.data); if (!grant) throw new Error('invalid grant');
            if (grant.purpose === 'link' || grant.purpose === 'unlink') { await continueIdentity({ grantId: grant.grantId, grantSecret: grant.grantSecret, purpose: grant.purpose, targetIdentityId: grant.targetIdentityId }, generation); return; }
            if (grant.purpose === 'recovery_code_generate') {
                clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
                if (grant.activeCodeGeneration !== null) { setStatus('generate'); return; }
                try {
                    const generated = await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: { grantId: grant.grantId, grantSecret: grant.grantSecret } });
                    if (stale()) return;
                    const data = (generated.data as { data?: { pendingCodeId?: unknown; code?: unknown; expiresAt?: unknown; serverNow?: unknown } }).data;
                    if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error('invalid code');
                    setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code);
                    setPendingExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null);
                    setSkewMs(serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null));
                    setStatus('display'); return;
                } catch (cause: unknown) {
                    // An ambiguous transport failure may have committed while
                    // consuming the grant, leaving a pending code whose
                    // one-time plaintext is irretrievable. A pending status
                    // reading back routes to cancel-and-regenerate guidance
                    // instead of the generic failed view; anything else
                    // rethrows into it.
                    const failed = statusOf(cause);
                    if (failed === undefined || failed >= 500) {
                        try {
                            const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
                            if (stale()) return;
                            const live = (current.data as { data?: { status?: unknown } }).data;
                            if (live?.status === 'pending') { setGrant(null); setStatus('generate_ambiguous'); return; }
                        } catch { /* reload failed; fall through to failed */ }
                    }
                    throw cause;
                }
            }
            if (grant.purpose === 'recovery_code_remove') { clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret }); setStatus('remove'); return; }
            if (grant.purpose !== 'recovery_code_activate' || !grant.pendingCodeId) throw new Error('missing pending');
            clearRecoveryIntent();
            // The user re-enters the value here after the second fresh proof; it was never persisted through the redirect.
            // A replacement additionally requires the current code the backend still enforces.
            setPendingCodeId(grant.pendingCodeId); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
            setNeedsOldCode(grant.activeCodeGeneration !== null);
            try {
                // The expected generation is required for safe reconciliation
                // after an ambiguous activation response. Fail closed until
                // we can establish it from the server.
                if (!await refreshPendingCodeStatus(grant.pendingCodeId, generation)) setError('The pending recovery code could not be confirmed yet. Retry the status check before activating it.');
            } catch {
                setExpectedGeneration(null);
                setError('The pending recovery code could not be confirmed yet. Retry the status check before activating it.');
            }
            setStatus('activate');
        }).catch((cause: unknown) => {
            // A still-redeeming attempt stays retryable: converting it to
            // the permanent failed view would falsely report failure when
            // the user checks before the winner finishes. Anything else
            // is terminal.
            if (stale()) return;
            if (isRetryableFinishConflict(cause)) { setStatus('waiting'); return; }
            clearRecoveryIntent(); setStatus('failed');
        }).finally(() => { finishInFlight.current = false; });
    };
    useEffect(() => {
        // Backoff polling while the winner redeems: bounded automatic
        // checks, then the manual button keeps the outcome retryable
        // indefinitely instead of failing on its own.
        if (status !== 'waiting' || waitingAutoTries.current >= 6) return;
        const delay = Math.min(1000 * 2 ** waitingAutoTries.current, 8000);
        waitingAutoTries.current += 1;
        const timer = window.setTimeout(() => { setStatus('checking'); runFinish(); }, delay);
        return () => window.clearTimeout(timer);
    }, [status]);
    useEffect(() => {
        if (started.current) return; started.current = true;
        if (unavailable) return;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('failed'); return; }
        // A duplicate callback racing the winner's redemption lands here
        // with the outcome still open: an immediate finish would 409 on
        // `processing` and misreport failure, so hold the retryable
        // waiting view instead of posting.
        if (duplicate) { setStatus('waiting'); return; }
        runFinish();
    }, [attemptId, unavailable]);
    const continueIdentity = async (grant: { grantId: string; grantSecret: string; purpose: 'link' | 'unlink'; targetIdentityId: string | null }, generation: number): Promise<void> => {
        const stale = () => generation !== accountGeneration.current;
        if (stale()) return;
        const auth = { grantId: grant.grantId, grantSecret: grant.grantSecret };
        if (grant.purpose === 'link') {
            const handoff = readSsoHandoff(tabStorage());
            if (!handoff) { setStatus('link_unavailable'); return; }
            try {
                const response = await studentSsoSessionApiClient.post('/auth/student/sso/link', { handoffId: handoff.handoffId, handoffSecret: handoff.handoffSecret, reauthGrant: auth });
                if (stale()) return;
                if (parseSsoLinkResponse(response.status, response.data)?.kind !== 'linked') throw new Error('not linked');
                clearSsoHandoff(tabStorage()); window.location.assign(handoff.returnPath); return;
            } catch (cause: unknown) {
                if (stale()) return;
                const result = parseSsoLinkResponse(statusOf(cause), bodyOf(cause));
                // Only terminal mismatch/restart outcomes spend the handoff.
                // Ambiguous failures (network loss, 5xx) keep the tab's copy
                // so the live server-side handoff stays retryable with a
                // fresh grant, mirroring the onboarding link flow — but the
                // commit may already have consumed it, so the outcome is
                // reported as ambiguous-link rather than recovery failure,
                // directing the user to verify via a fresh sign-in.
                if (!result || result.kind === 'linked') { setStatus('link_ambiguous'); return; }
                clearSsoHandoff(tabStorage());
                setStatus('link_unavailable'); return;
            }
        }
        if (!grant.targetIdentityId) { setStatus('failed'); return; }
        try {
            const response = await studentSsoSessionApiClient.post(`/auth/student/sso/identities/${grant.targetIdentityId}/unlink`, { reauthGrant: auth });
            if (stale()) return;
            const data = (response.data as { success?: unknown; data?: unknown })?.success === true ? (response.data as { data?: unknown }).data as { unlinked?: unknown; sessionRevoked?: unknown } : null;
            if (!data || data.unlinked !== true || typeof data.sessionRevoked !== 'boolean') throw new Error('invalid unlink');
            // The server clears the session only when the removed identity
            // issued it; drop local tokens exactly then, before rendering.
            if (data.sessionRevoked) { intentionalSignOut.current = true; clearTokens(); }
            setStatus(data.sessionRevoked ? 'unlinked_signed_out' : 'unlinked');
        } catch (cause: unknown) {
            if (stale()) return;
            const body = bodyOf(cause) as { error?: { code?: unknown } } | undefined;
            if (statusOf(cause) === 409 && body?.error?.code === 'SSO_LAST_LOGIN_METHOD') { setStatus('last_method'); return; }
            if (statusOf(cause) === 409 && body?.error?.code === 'SSO_LAST_PROOF_METHOD') { setStatus('last_proof_method'); return; }
            // Ambiguous transport failures (network loss, 5xx) may have
            // committed: the grant is then consumed and retrying cannot
            // confirm the outcome. Reload before reporting failure — a
            // missing target means the removal landed, and the 200 proves
            // the session survived (a server-cleared session 401s through
            // the session client's global expired-session handling instead).
            const failed = statusOf(cause);
            if (failed === undefined || failed >= 500) {
                try {
                    // Mark before the GET: its 401 interceptor clears the
                    // session synchronously, before this catch observes the
                    // rejection. The layout fence accepts this only if no
                    // replacement browser session is present.
                    intentionalSignOut.current = true;
                    const current = await studentSsoSessionApiClient.get('/auth/student/sso/identities');
                    intentionalSignOut.current = false;
                    if (stale()) return;
                    const listed = (current.data as { data?: { identities?: unknown } }).data?.identities;
                    if (Array.isArray(listed) && !listed.some((entry) => (entry as { id?: unknown } | null)?.id === grant.targetIdentityId)) {
                        setStatus('unlinked'); return;
                    }
                } catch (inner: unknown) {
                    // On this /auth/ page the session interceptor clears
                    // tokens without redirecting, so a 401 here is the
                    // committed outcome with the session revoked by the
                    // removed identity: report the signed-out removal
                    // instead of generic failure.
                    if (statusOf(inner) === 401 && getSessionSnapshot().browserSessionId === null) {
                        intentionalSignOut.current = false;
                        setStatus('unlinked_signed_out'); return;
                    }
                    intentionalSignOut.current = false;
                    if (stale()) return;
                    /* other reload failures fall through below */
                }
            }
            setStatus('failed');
        }
    };
    const activate = async () => {
        const session = getSessionSnapshot(); if (actionBusy.current || expectedGeneration === null || !grant || !pendingCodeId || !session.accessToken || !code || (needsOldCode && !oldCode)) return; actionBusy.current = true; setBusy(true);
        const generation = accountGeneration.current;
        const stale = () => generation !== accountGeneration.current;
        const pendingId = pendingCodeId;
        const reconcile = async (): Promise<boolean> => {
            try {
                const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
                if (stale()) return false;
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
            await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/activate', { reauthGrant: grant, pendingCodeId: pendingId, code, ...(needsOldCode ? { oldCode } : {}) });
            if (stale()) return;
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
        const generation = accountGeneration.current;
        const stale = () => generation !== accountGeneration.current;
        try { const r = await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: grant, oldCode: code }); if (stale()) return; const data = (r.data as { data?: { pendingCodeId?: unknown; code?: unknown; expiresAt?: unknown; serverNow?: unknown } }).data; if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error(); setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code); setPendingExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null); setSkewMs(serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null)); setStatus('display'); } catch (cause: unknown) {
            // An ambiguous transport failure may have committed: the grant
            // is then consumed and the replacement plaintext is lost with
            // the response. A pending code reading back proves the commit —
            // guide cancel-and-regenerate instead of reporting failure.
            const failed = statusOf(cause);
            if (failed === undefined || failed >= 500) {
                try {
                    const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
                    if (stale()) return;
                    const live = (current.data as { data?: { status?: unknown } }).data;
                    if (live?.status === 'pending') { setGrant(null); setCode(''); setStatus('generate_ambiguous'); return; }
                } catch { /* reload failed; fall through to the generic error */ }
            }
            setError('The current recovery code could not be confirmed.');
        } finally { actionBusy.current = false; setBusy(false); }
    };
    const remove = async () => {
        const session = getSessionSnapshot(); if (actionBusy.current || !grant || !session.accessToken || !code) return; actionBusy.current = true; setBusy(true);
        const generation = accountGeneration.current;
        const stale = () => generation !== accountGeneration.current;
        try { await studentSsoSessionApiClient.post('/auth/student/sso/recovery-code/remove', { reauthGrant: grant, oldCode: code }); if (stale()) return; setGrant(null); setCode(''); setStatus('removed'); } catch (cause: unknown) {
            // An ambiguous transport failure may have committed while
            // consuming the grant. An unconfigured status reading back
            // proves the removal landed: render it instead of failure.
            const failed = statusOf(cause);
            if (failed === undefined || failed >= 500) {
                try {
                    const current = await studentSsoSessionApiClient.get('/auth/student/sso/recovery-code');
                    if (stale()) return;
                    const live = (current.data as { data?: { status?: unknown } }).data;
                    if (live?.status === 'unconfigured') { setGrant(null); setCode(''); setStatus('removed'); return; }
                } catch { /* reload failed; fall through to the generic error */ }
            }
            setError('The current recovery code could not be confirmed.');
        } finally { actionBusy.current = false; setBusy(false); }
    };
    if (status === 'generate') return <AuthShell role="student" title="Replace recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="old-recovery-code">Current recovery code<input id="old-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button disabled={busy} className="mt-5 w-full rounded-full" onClick={generateReplacement}>Generate replacement code</Button></AuthShell>;
    if (pendingExpired) return <AuthShell role="student" title="Pending code expired" subtitle="The activation deadline passed." footer={null}><p role="alert">This pending code expired before activation and cannot recover your account. Start setup again for a fresh code.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'display') return <AuthShell role="student" title="Save your recovery code" subtitle="It will not be shown again." footer={null}><p role="alert" className="rounded-xl bg-amber-50 p-3 break-all font-mono text-left">{code}</p>{Number.isNaN(pendingDeadlineMs) ? null : <p role="timer" className="mt-3 text-left text-sm">Activate this code within {formatPendingRemaining(pendingDeadlineMs, now + skewMs)}.</p>}<p className="mt-3 text-left text-sm">Save this code somewhere secure. It is not stored in this browser, sent by email, or added to a URL. Then return to Account security and confirm your identity again to activate it.</p><Button className="mt-5 w-full rounded-full" onClick={() => { if (pendingCodeId) try { sessionStorage.setItem(RECOVERY_INTENT_KEY, JSON.stringify({ purpose: 'recovery_code_activate', pendingCodeId })); } catch { /* security page reports unavailable */ } setCode(''); window.location.href = '/student/security'; }}>I saved my code</Button></AuthShell>;
    if (status === 'activate') return <AuthShell role="student" title="Confirm your recovery code" subtitle="Fresh identity confirmation completed." footer={null}>{Number.isNaN(pendingDeadlineMs) ? null : <p role="timer" className="mb-3 text-left text-sm">Activate this code within {formatPendingRemaining(pendingDeadlineMs, now + skewMs)}.</p>}{expectedGeneration === null ? <div className="mb-3 space-y-2"><p role="status" className="text-sm">The pending recovery code status has not been confirmed. Activation is disabled until the server confirms which code generation is pending.</p><Button type="button" variant="outline" disabled={busy} className="w-full rounded-full" onClick={async () => { setBusy(true); setError(null); try { if (!await refreshPendingCodeStatus()) setError('The pending recovery code is not available for activation. Return to account security and start again.'); } catch { setError('The status check failed. Retry while the confirmation is still open.'); } finally { setBusy(false); } }}>Retry status check</Button></div> : null}<label className="block text-left text-sm" htmlFor="recovery-code-confirm">Re-enter saved recovery code<input id="recovery-code-confirm" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{needsOldCode ? <label className="mt-3 block text-left text-sm" htmlFor="recovery-code-current">Current recovery code<input id="recovery-code-current" value={oldCode} onChange={e => setOldCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label> : null}{error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}<Button disabled={busy || expectedGeneration === null} className="mt-5 w-full rounded-full" onClick={activate}>Activate recovery code</Button></AuthShell>;
    if (status === 'remove') return <AuthShell role="student" title="Remove recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="remove-recovery-code">Current recovery code<input id="remove-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button disabled={busy} className="mt-5 w-full rounded-full" onClick={remove}>Remove recovery code</Button></AuthShell>;
    if (status === 'active') return <AuthShell role="student" title="Recovery code active" subtitle="Your optional recovery setup is complete." footer={null}><p role="status">Keep your saved code secure. It is required with your school mailbox for independent password recovery.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/marketplace">Continue</Link></Button></AuthShell>;
    if (status === 'removed') return <AuthShell role="student" title="Recovery code removed" subtitle="Recovery is now unconfigured." footer={null}><p role="status">The saved code was revoked and can no longer recover this account. Set up a new code from Account security if you still want recovery.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'link_unavailable') return <AuthShell role="student" title="School sign-in link unavailable" subtitle="This sign-in can no longer be linked." footer={null}><p role="status">The pending school sign-in expired or was already used. Restart school sign-in and try again.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Back to sign-in</Link></Button></AuthShell>;
    if (status === 'link_ambiguous') return <AuthShell role="student" title="School sign-in link unclear" subtitle="The confirmation was lost." footer={null}><p role="status">This school sign-in may already be linked. Sign in again to check your sign-in methods before retrying.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Sign in to check</Link></Button></AuthShell>;
    if (status === 'waiting') return <AuthShell role="student" title="Confirmation still completing" subtitle="Another confirmation is finishing." footer={null}><p role="status">This confirmation arrived twice and the first is still completing. Wait a moment, then check again — nothing failed yet.</p><Button className="mt-5 w-full rounded-full" onClick={() => { waitingAutoTries.current = 0; setStatus('checking'); runFinish(); }}>Check again</Button></AuthShell>;
    if (status === 'generate_ambiguous') return <AuthShell role="student" title="Replacement code unclear" subtitle="The confirmation was lost." footer={null}><p role="status">A replacement code was created but its response was lost, so the code cannot be shown again. Go to Account security, cancel the pending code, and generate a new one.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'unlinked') return <AuthShell role="student" title="Sign-in method removed" subtitle="The school sign-in was disconnected." footer={null}><p role="status">That school sign-in can no longer access this account.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'unlinked_signed_out') return <AuthShell role="student" title="Sign-in method removed" subtitle="You have been signed out." footer={null}><p role="status">The removed sign-in had issued this session, so the local sign-in was cleared. That school sign-in can no longer access this account.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Back to sign-in</Link></Button></AuthShell>;
    if (status === 'last_method') return <AuthShell role="student" title="Cannot remove the last sign-in method" subtitle="Keep another way to sign in first." footer={null}><p role="status">Removing this sign-in would lock the account. Link another school sign-in or set a password first.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (status === 'last_proof_method') return <AuthShell role="student" title="Microsoft sign-in still needed" subtitle="Security confirmations need it." footer={null}><p role="status">Removing this Microsoft sign-in would strand security confirmations. Link another Microsoft sign-in first.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    if (unavailable) return <AuthShell role="student" title="School sign-in is unavailable" subtitle="The security confirmation was interrupted during rollback." footer={null}><p role="status">No security change was made. Return to Account security and try again when Microsoft sign-in is available.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
    return <AuthShell role="student" title="Security confirmation unavailable" subtitle="The fresh confirmation expired or was interrupted." footer={null}><p role="status">No recovery code was activated. Start the optional setup again.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
}

type CompleteView =
    | { kind: 'checking' }
    | { kind: 'waiting' }
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
    const finishInFlight = useRef(false);
    const waitingAutoTries = useRef(0);

    const reauthAttempt = search.get('reauth');

    const runLoginFinish = useCallback(async (): Promise<void> => {
        if (finishInFlight.current) return;
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
            if (finishInFlight.current) return;
            finishInFlight.current = true;
            try {
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
                // A still-redeeming attempt stays retryable: converting it
                // to a login error would misreport a duplicate whose winner
                // has not settled yet. Anything else fails through below.
                if (isRetryableFinishConflict(cause)) { setView({ kind: 'waiting' }); return; }
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
            // The onboarding conflict flow signs an existing account in
            // from the same tab and returns to onboarding to link: the
            // waiting link handoff must survive this authenticated
            // completion, unlike a stale handoff after an ordinary login.
            // The continuation consumes it; the server stays authoritative.
            const onboardingReturn = record.returnPath === STUDENT_SSO_ONBOARDING_RETURN_PATH
                || record.returnPath.startsWith(`${STUDENT_SSO_ONBOARDING_RETURN_PATH}?`);
            if (!onboardingReturn) clearSsoHandoff(storage);
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
            } finally {
                finishInFlight.current = false;
            }
        };
        void finish();
    }, [search, completeSsoLogin]);

    useEffect(() => {
        if (reauthAttempt) return;
        if (started.current) return;
        started.current = true;
        void runLoginFinish();
    }, [reauthAttempt, runLoginFinish]);

    // Bounded automatic checks while a duplicate redemption settles, then
    // the manual button keeps the outcome retryable without failing.
    useEffect(() => {
        if (reauthAttempt) return;
        if (view.kind !== 'waiting' || waitingAutoTries.current >= 6) return;
        const delay = Math.min(1000 * 2 ** waitingAutoTries.current, 8000);
        waitingAutoTries.current += 1;
        const timer = setTimeout(() => { setView({ kind: 'checking' }); void runLoginFinish(); }, delay);
        return () => clearTimeout(timer);
    }, [reauthAttempt, view.kind, runLoginFinish]);

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

    if (reauthAttempt) return <RecoveryReauthComplete attemptId={reauthAttempt} duplicate={search.get('reauthDuplicate') === '1'} unavailable={search.get('reauthUnavailable') === '1'} />;

    if (view.kind === 'waiting') {
        return (
            <MicrosoftCallbackShell provider="school" label="School sign-in" status="loading" title="Sign-in still completing" subtitle="Another sign-in is finishing.">
                <p role="status">This sign-in arrived twice and the first is still completing. Wait a moment, then check again — nothing failed yet.</p>
                <Button className="mt-5 min-h-11 w-full rounded-full" onClick={() => { waitingAutoTries.current = 0; setView({ kind: 'checking' }); void runLoginFinish(); }}>
                    Check again
                </Button>
            </MicrosoftCallbackShell>
        );
    }

    if (view.kind === 'link_required') {
        return (
            <MicrosoftCallbackShell
                provider={view.provider}
                label="School sign-in"
                title="Link your school account"
                subtitle="This school sign-in is not linked to an Awoof account yet."
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
            </MicrosoftCallbackShell>
        );
    }

    if (view.kind === 'already_signed_in') {
        return (
            <MicrosoftCallbackShell provider="school" label="School sign-in" title="Already signed in" subtitle="This device already has a signed-in account.">
                <p role="status" className="text-left text-sm text-slate-600">
                    The school sign-in was discarded and nothing was replaced.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href={view.continuePath}>Continue</Link>
                </Button>
            </MicrosoftCallbackShell>
        );
    }

    if (view.kind === 'discarded') {
        return (
            <MicrosoftCallbackShell provider="school" label="School sign-in" title="Sign-in discarded" subtitle="Another account signed in on this tab.">
                <p role="status" className="text-left text-sm text-slate-600">
                    Your school sign-in finished after another account signed in here, so it was discarded and nothing
                    was replaced.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href="/marketplace">Continue to marketplace</Link>
                </Button>
            </MicrosoftCallbackShell>
        );
    }

    return (
        <MicrosoftCallbackShell provider="school" label="School sign-in" status="loading" title="Completing school sign-in">
            <p role="status" className="text-left text-sm text-slate-600">
                Finishing your school sign-in. You will continue automatically when it is ready.
            </p>
        </MicrosoftCallbackShell>
    );
}

export default function StudentSsoCompletePage() {
    return (
        <Suspense fallback={
            <MicrosoftCallbackShell provider="school" label="School sign-in" title="Completing school sign-in" status="loading">
                <p role="status">Preparing to finish your school sign-in…</p>
            </MicrosoftCallbackShell>
        }>
            <StudentSsoCompleteInner />
        </Suspense>
    );
}
