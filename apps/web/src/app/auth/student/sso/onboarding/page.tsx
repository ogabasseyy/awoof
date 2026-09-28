/**
 * Student SSO onboarding: completes a stored unlinked-identity handoff.
 * The complete page stores the handoff in this tab and stays signed out;
 * this page binds it to the freshly password-proven owner (reauth, then
 * link) and preserves claim continuation. The handoff secret never leaves
 * tab storage except inside the link POST body. Both calls carry the
 * password session's Bearer token explicitly, since the SSO client
 * installs no session interceptors.
 */

'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { studentSsoApiClient } from '@/lib/api-client';
import { getSessionSnapshot, storeTokens } from '@/lib/auth';
import { resolveStudentReturn } from '@/lib/student-return';
import {
    clearSsoAttempt,
    clearSsoHandoff,
    isSsoAttemptLive,
    parseSsoLinkResponse,
    parseSsoReauthResponse,
    readSsoHandoff,
    type SsoHandoffRecord,
} from '@/lib/student-login-flow';

type OnboardingView =
    | { kind: 'checking' }
    | { kind: 'no_handoff' }
    | { kind: 'needs_signin' }
    | { kind: 'ready'; handoff: SsoHandoffRecord; error: string | null; busy: boolean }
    | { kind: 'mismatch' }
    | { kind: 'restart' }
    | { kind: 'unavailable' };

const ONBOARDING_PATH = '/auth/student/sso/onboarding';

function tabStorage(): Storage | null {
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

function continuationPath(): string {
    const storage = tabStorage();
    // The complete page clears the attempt when the handoff is stored, so
    // the handoff's carried return path is the continuation source.
    const handoff = readSsoHandoff(storage);
    return resolveStudentReturn(handoff?.returnPath ?? null, window.location.origin);
}

function forgetHandoff(): void {
    const storage = tabStorage();
    clearSsoHandoff(storage);
    clearSsoAttempt(storage);
}

function statusOf(cause: unknown): number | undefined {
    return axios.isAxiosError(cause) ? cause.response?.status : undefined;
}

function bodyOf(cause: unknown): unknown {
    return axios.isAxiosError(cause) ? cause.response?.data : undefined;
}

type SignupContext = { email: string; universityId: string; termsVersion: string; noticeVersion: string; noticeText: string; expiresAt: string };

function signupContext(value: unknown): SignupContext | null {
    const data = (value as { success?: unknown; data?: unknown })?.success === true ? (value as { data?: unknown }).data : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const v = data as Record<string, unknown>;
    return typeof v.email === 'string' && typeof v.universityId === 'string' && typeof v.termsVersion === 'string'
        && typeof v.noticeVersion === 'string' && typeof v.noticeText === 'string' && typeof v.expiresAt === 'string'
        ? { email: v.email, universityId: v.universityId, termsVersion: v.termsVersion, noticeVersion: v.noticeVersion, noticeText: v.noticeText, expiresAt: v.expiresAt }
        : null;
}

function formatSignupRemaining(deadlineMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function SignupOnboarding() {
    const [context, setContext] = useState<SignupContext | null>(null);
    const [skewMs, setSkewMs] = useState(0);
    const [ambiguousComplete, setAmbiguousComplete] = useState(false);
    const [existingAccount, setExistingAccount] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [challengeId, setChallengeId] = useState<string | null>(null);
    const [code, setCode] = useState(''); const [name, setName] = useState('');
    const [age, setAge] = useState(false); const [terms, setTerms] = useState(false); const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
    const [createdDestination, setCreatedDestination] = useState<string | null>(null);
    const started = useRef(false); const initialSession = useRef<number | null>(null);
    const handoff = useRef<SsoHandoffRecord | null>(null);
    useEffect(() => {
        if (started.current) return; started.current = true;
        const record = readSsoHandoff(tabStorage());
        if (!record || !isSsoAttemptLive(record, Date.now()) || getSessionSnapshot().accessToken) { forgetHandoff(); setError('This setup link expired or this tab changed accounts. Start Microsoft sign-in again.'); return; }
        handoff.current = record; setSkewMs(record.serverSkewMs); initialSession.current = getSessionSnapshot().generation;
        void studentSsoApiClient.post('/auth/student/sso/signup/context', { handoffId: record.handoffId, handoffSecret: record.handoffSecret })
            .then(response => { const parsed = signupContext(response.data); if (!parsed) throw new Error('invalid'); setContext(parsed); })
            .catch(() => setError('This setup link is unavailable or expired. Start Microsoft sign-in again.'));
    }, []);
    useEffect(() => {
        if (!context) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [context]);
    useEffect(() => {
        // The notice below delivers the post-signup recovery guidance, so
        // showing it consumes the fresh-signup marker and the marketplace
        // backstop stays silent.
        if (createdDestination === null) return;
        try { sessionStorage.removeItem('awoof.passwordless-signup-fresh'); } catch { /* already consumed */ }
    }, [createdDestination]);
    // The ten-minute handoff window can lapse while the student waits for
    // mail or fills the form. The countdown names the deadline up front and
    // the page swaps to an explicit restart state at expiry instead of
    // presenting controls whose next request fails generically. The
    // server-issued deadline is evaluated on the server clock using the
    // skew sampled at sign-in start, so a fast device clock cannot expire
    // a live handoff early.
    const deadlineMs = context ? Date.parse(context.expiresAt) : NaN;
    const linkExpired = context !== null && !Number.isNaN(deadlineMs) && deadlineMs <= now + skewMs;
    useEffect(() => { if (linkExpired) forgetHandoff(); }, [linkExpired]);
    const requestCode = async () => {
        if (!handoff.current || busy) return; setBusy(true); setError(null);
        try { const r = await studentSsoApiClient.post('/auth/student/sso/signup/send-code', { handoffId: handoff.current.handoffId, handoffSecret: handoff.current.handoffSecret }); const data = (r.data as { data?: { challengeId?: unknown } }).data; if (typeof data?.challengeId !== 'string') throw new Error('invalid'); setChallengeId(data.challengeId); }
        catch { setError('We could not send a confirmation code. Restart Microsoft sign-in if this persists.'); } finally { setBusy(false); }
    };
    const verifyCode = async () => {
        if (!handoff.current || !challengeId || !/^\d{6}$/.test(code) || busy) return; setBusy(true); setError(null);
        try { await studentSsoApiClient.post('/auth/student/sso/signup/verify-code', { handoffId: handoff.current.handoffId, handoffSecret: handoff.current.handoffSecret, challengeId, code }); setChallengeId('verified'); setCode(''); }
        catch { setError('That confirmation code is invalid or expired. Request a new code.'); } finally { setBusy(false); }
    };
    const refreshContext = async (): Promise<boolean> => {
        if (!handoff.current) return false;
        try {
            const response = await studentSsoApiClient.post('/auth/student/sso/signup/context', { handoffId: handoff.current.handoffId, handoffSecret: handoff.current.handoffSecret });
            const parsed = signupContext(response.data);
            if (!parsed) return false;
            setContext(parsed);
            return true;
        } catch { return false; }
    };
    const complete = async () => {
        if (!handoff.current || challengeId !== 'verified' || !age || !terms || !consent || name.trim().length < 2 || busy) return;
        if (initialSession.current !== getSessionSnapshot().generation || getSessionSnapshot().accessToken) { setError('This tab changed accounts. Restart Microsoft sign-in.'); return; }
        setBusy(true); setError(null);
        let response: { data: unknown };
        try {
            response = await studentSsoApiClient.post('/auth/student/sso/signup/complete', { handoffId: handoff.current.handoffId, handoffSecret: handoff.current.handoffSecret, fullName: name.trim(), ageAttested: true, termsAccepted: true, termsVersion: context!.termsVersion, verificationConsent: true, noticeVersion: context!.noticeVersion });
        } catch (cause: unknown) {
            // A 400 here means the Terms or notice version moved mid-window
            // (a rolling deploy serving context and complete from different
            // releases): this client already guarantees checked boxes and a
            // bounded name, so refetch the text and reset assent instead of
            // retrying the same rejected versions forever.
            if (statusOf(cause) === 400 && await refreshContext()) {
                setAge(false); setTerms(false); setConsent(false);
                setError('The Terms or processing notice changed while you were signing up. Review the new text and accept again.');
            } else if (statusOf(cause) === 409 && (bodyOf(cause) as { error?: { code?: unknown } } | undefined)?.error?.code === 'SSO_SIGNUP_EXISTING_ACCOUNT') {
                // Only the distinct existing-account conflict routes to
                // linking: the school email already belongs to an Awoof
                // account (or the subject is linked elsewhere), this
                // signup can never succeed, but the handoff stays live.
                // Every other 409 (expired handoff, withdrawn policy)
                // keeps the generic retry instead of misdirecting an
                // unusable handoff into password linking.
                setExistingAccount(true);
            } else if (axios.isAxiosError(cause) && (!cause.response || cause.response.status >= 500)) {
                // Response-loss/5xx after account creation is ambiguous:
                // the handoff was consumed with the account, so no retry of
                // this form can succeed. A fresh Microsoft sign-in discovers
                // the newly linked identity instead. Local validation
                // failures are not axios errors and keep the generic retry.
                forgetHandoff(); setAmbiguousComplete(true);
            } else {
                setError('We could not finish setup. Your confirmed details were not silently accepted; retry or restart Microsoft sign-in.');
            }
            setBusy(false);
            return;
        }
        // The 201 committed the account and consumed the handoff: every
        // failure below is client-side (unparseable shape, a session
        // switch that must not clobber the newer session, unavailable
        // storage). Report the created outcome and clear the spent
        // handoff — never a retryable "not accepted" form, since no
        // retry of the consumed handoff can succeed.
        try {
            const data = (response.data as { data?: { tokens?: { accessToken?: unknown; refreshToken?: unknown } } }).data;
            if (!data || typeof data.tokens?.accessToken !== 'string' || typeof data.tokens.refreshToken !== 'string' || initialSession.current !== getSessionSnapshot().generation) throw new Error('unusable');
            // Preserve the validated continuation the handoff carried for
            // this sign-in; resolve it before the handoff is forgotten.
            // Mark this tab's fresh passwordless signup so the
            // post-continuation recovery offer ("Save your recovery code")
            // can surface outside this journey, per the signup spec,
            // without blocking the redirect below.
            const destination = resolveStudentReturn(handoff.current?.returnPath ?? null, window.location.origin);
            storeTokens({ accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken }); forgetHandoff();
            try { sessionStorage.setItem('awoof.passwordless-signup-fresh', '1'); } catch { /* the offer simply stays hidden */ }
            // Route through the post-signup notice instead of redirecting
            // straight to the continuation: the recovery warning must
            // reach the new account whatever the destination is. The
            // notice consumes the marker when shown; if the tab is
            // abandoned first, the marketplace offer stays as backstop.
            setCreatedDestination(destination);
        } catch {
            forgetHandoff(); setAmbiguousComplete(true);
        } finally {
            setBusy(false);
        }
    };
    if (createdDestination !== null) return <AuthShell role="student" title="Account created" subtitle="Your passwordless account is ready." footer={null}><p role="status" className="text-left text-sm">Recovery is not configured, and losing your school sign-in may prevent account access. Save a recovery code so you can recover with your school mailbox.</p><div className="mt-5 space-y-2"><Button className="w-full rounded-full" asChild><Link href="/student/security">Save your recovery code</Link></Button><Button variant="outline" className="w-full rounded-full" onClick={() => { window.location.href = createdDestination; }}>Continue</Button></div></AuthShell>;
    if (!context) return <AuthShell role="student" title="Finish setting up Awoof" subtitle="Checking your school sign-in." footer={null}><p role="status">{error ?? 'Checking the pending sign-in…'}</p>{error ? <Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Restart Microsoft sign-in</Link></Button> : null}</AuthShell>;
    if (ambiguousComplete) return <AuthShell role="student" title="Finish setting up Awoof" subtitle="Setup may have completed." footer={null}><p role="alert">Setup may have finished but the confirmation was lost. Sign in with Microsoft again: if your account was created, you will be signed straight in.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Sign in with Microsoft</Link></Button></AuthShell>;
    if (existingAccount) return <AuthShell role="student" title="Finish setting up Awoof" subtitle="An account already uses this email." footer={null}><p role="alert">An Awoof account already uses this school email, so a new account cannot be created. Sign in to that account with your password — you will return here to link Microsoft school sign-in instead.</p><Button className="mt-5 w-full rounded-full" asChild><Link href={`/auth/student/login?redirect=${encodeURIComponent(ONBOARDING_PATH)}`}>Sign in to link instead</Link></Button></AuthShell>;
    if (linkExpired) return <AuthShell role="student" title="Finish setting up Awoof" subtitle="This setup link expired." footer={null}><p role="alert">This setup link expired before setup finished. Start Microsoft sign-in again for a fresh link.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/auth/student/login">Restart Microsoft sign-in</Link></Button></AuthShell>;
    return <AuthShell role="student" title="Finish setting up Awoof" subtitle="Create an account without a password." footer={null}>
        <p className="text-left text-sm text-slate-600">Microsoft sign-in succeeded. Confirm <strong>{context.email}</strong> for your Awoof account and recovery. Enrollment is pending; confirming this email does not verify current enrollment or independently verify age.</p>
        {Number.isNaN(deadlineMs) ? null : <p role="timer" className="mt-3 text-left text-sm text-slate-600">This setup link expires in {formatSignupRemaining(deadlineMs, now + skewMs)}. Finish before then or restart Microsoft sign-in.</p>}
        {!challengeId ? <Button type="button" onClick={requestCode} disabled={busy} className="mt-5 w-full rounded-full">{busy ? 'Sending…' : 'Send confirmation code'}</Button> : challengeId !== 'verified' ? <div className="mt-5 space-y-3"><label className="block text-left text-sm font-medium" htmlFor="signup-code">Email confirmation code<input id="signup-code" aria-label="Email confirmation code" inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label><Button type="button" onClick={verifyCode} disabled={busy || !/^\d{6}$/.test(code)} className="w-full rounded-full">Confirm email</Button><Button type="button" variant="outline" onClick={requestCode} disabled={busy} className="w-full rounded-full">Request a new code</Button></div> : <div className="mt-5 space-y-3"><label className="block text-left text-sm font-medium" htmlFor="signup-name">Full name<input id="signup-name" aria-label="Full name" value={name} onChange={e => setName(e.target.value)} maxLength={255} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label><label className="flex gap-2 text-left text-sm"><input aria-label="I am at least 18 years old" type="checkbox" checked={age} onChange={e => setAge(e.target.checked)} />I am at least 18 years old</label><p className="text-left text-sm text-slate-600">Creating an account records your acceptance of version {context.termsVersion} of the <Link href="/terms" target="_blank" rel="noreferrer" className="text-primary underline">Terms of Service</Link>.</p><label className="flex gap-2 text-left text-sm"><input aria-label="I accept the current Terms" type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} />I accept the current Terms</label><p className="text-left text-sm text-slate-600">Processing notice ({context.noticeVersion}): {context.noticeText}</p><label className="flex gap-2 text-left text-sm"><input aria-label="I consent to the processing notice" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to the processing notice</label><Button type="button" onClick={complete} disabled={busy || !age || !terms || !consent || name.trim().length < 2} className="w-full rounded-full">Create passwordless account</Button></div>}
        {error ? <p role="alert" className="mt-3 text-left text-sm text-red-600">{error}</p> : null}
    </AuthShell>;
}

function StudentSsoOnboardingInner() {
    const search = useSearchParams();
    const signupMode = search.get('mode') === 'signup';
    const [view, setView] = useState<OnboardingView>({ kind: 'checking' });
    const [password, setPassword] = useState('');
    const startedRef = useRef(false);
    const reauthFailures = useRef(0);

    useEffect(() => {
        if (signupMode) return;
        if (startedRef.current) return;
        startedRef.current = true;
        const handoff = readSsoHandoff(tabStorage());
        if (!handoff || !isSsoAttemptLive(handoff, Date.now())) {
            forgetHandoff();
            setView({ kind: 'no_handoff' });
            return;
        }
        setView({ kind: 'ready', handoff, error: null, busy: false });
    }, [signupMode]);

    if (signupMode) return <SignupOnboarding />;

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        if (view.kind !== 'ready' || view.busy || password.length === 0) return;
        // Both endpoints require the password session: without a local
        // access token no request is sent and the user signs in first.
        // The token is attached explicitly — never via the refreshing
        // session client, whose retry would clear the session on a wrong
        // password.
        const session = getSessionSnapshot();
        if (!session.accessToken) {
            setView({ kind: 'needs_signin' });
            return;
        }
        const authHeaders = { Authorization: `Bearer ${session.accessToken}` };
        setView({ ...view, busy: true, error: null });
        let grant;
        try {
            const response = await studentSsoApiClient.post('/auth/student/sso/reauth', {
                password,
                purpose: 'link',
            }, { headers: authHeaders });
            grant = parseSsoReauthResponse(response.data);
        } catch (cause: unknown) {
            if (statusOf(cause) === 401) {
                // The boundary redacts every 401 identically, so a signed-in
                // 401 is read as a wrong password first; a repeat means the
                // session itself is dead and the user signs in again.
                reauthFailures.current += 1;
                if (reauthFailures.current >= 2 || !getSessionSnapshot().accessToken) {
                    setView({ kind: 'needs_signin' });
                    return;
                }
                setPassword('');
                setView({ ...view, busy: false, error: 'Current password is incorrect.' });
                return;
            }
            setView({ kind: 'unavailable' });
            return;
        }
        if (!grant) {
            setView({ kind: 'unavailable' });
            return;
        }
        reauthFailures.current = 0;
        let result;
        try {
            const response = await studentSsoApiClient.post('/auth/student/sso/link', {
                handoffId: view.handoff.handoffId,
                handoffSecret: view.handoff.handoffSecret,
                reauthGrant: { grantId: grant.grantId, grantSecret: grant.grantSecret },
            }, { headers: authHeaders });
            result = parseSsoLinkResponse(response.status, response.data);
        } catch (cause: unknown) {
            // The password already proved this session, so a link 401 means
            // the session died mid-flow: sign in again, handoff retained.
            if (statusOf(cause) === 401) {
                setView({ kind: 'needs_signin' });
                return;
            }
            result = parseSsoLinkResponse(statusOf(cause), bodyOf(cause));
        }
        if (!result) {
            setView({ kind: 'unavailable' });
            return;
        }
        if (result.kind === 'linked') {
            const destination = continuationPath();
            forgetHandoff();
            window.location.href = destination;
            return;
        }
        // Mismatch spends the handoff server-side; restart means the handoff
        // is gone. Both clear tab state and send the user back to start over.
        forgetHandoff();
        setPassword('');
        setView({ kind: result.kind });
    };

    if (view.kind === 'checking') {
        return (
            <AuthShell role="student" title="Linking school sign-in" subtitle="Checking the pending sign-in." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    Checking the pending sign-in…
                </p>
            </AuthShell>
        );
    }

    if (view.kind === 'no_handoff') {
        return (
            <AuthShell role="student" title="Nothing to link" subtitle="The pending school sign-in is gone." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    This tab holds no pending school sign-in — it expired, was used, or was never started here.
                    Start over from the password sign-in.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href="/auth/student/login">Back to sign-in</Link>
                </Button>
            </AuthShell>
        );
    }

    if (view.kind === 'needs_signin') {
        return (
            <AuthShell role="student" title="Sign in first" subtitle="Linking needs a signed-in account." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    Your session ended before linking. Sign in with your password — you will return here to finish
                    linking.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href={`/auth/student/login?redirect=${encodeURIComponent(ONBOARDING_PATH)}`}>
                        Sign in with your password
                    </Link>
                </Button>
            </AuthShell>
        );
    }

    if (view.kind === 'mismatch') {
        return (
            <AuthShell role="student" title="Different school account" subtitle="The returned account does not match." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    The school account returned is not the one being linked, so the attempt was spent. Sign in again
                    with the school account you intend to link.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href="/auth/student/login">Start over</Link>
                </Button>
            </AuthShell>
        );
    }

    if (view.kind === 'restart') {
        return (
            <AuthShell role="student" title="Link expired" subtitle="The pending sign-in is no longer valid." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    The pending school sign-in expired or was already used. Start over from the password sign-in.
                </p>
                <Button type="button" className="mt-5 w-full rounded-full h-11 font-semibold" asChild>
                    <Link href="/auth/student/login">Back to sign-in</Link>
                </Button>
            </AuthShell>
        );
    }

    if (view.kind === 'unavailable') {
        return (
            <AuthShell role="student" title="Linking unavailable" subtitle="School linking is not available right now." footer={null}>
                <p role="status" className="text-left text-sm text-slate-600">
                    Linking could not be completed. Nothing was linked and your password session is unchanged — try
                    again later or continue without linking.
                </p>
                <div className="mt-5 space-y-2">
                    <Button type="button" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/auth/student/login">Back to sign-in</Link>
                    </Button>
                    <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/student/verification">Continue without linking</Link>
                    </Button>
                </div>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            role="student"
            title="Prove it is you"
            subtitle="Confirm your password to link this school sign-in."
            footer={null}
        >
            <p role="status" className="text-left text-sm text-slate-600">
                Linking binds this school sign-in to your signed-in account. Enter your account password once —
                it is checked and never stored.
            </p>
            <form onSubmit={submit} className="mt-5 space-y-3">
                <label className="block text-left text-sm font-medium text-slate-700" htmlFor="sso-link-password">
                    Account password
                    <input
                        id="sso-link-password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={view.busy}
                        className="mt-1 w-full rounded-2xl border border-slate-200 px-4 h-11 text-sm"
                    />
                </label>
                {view.error ? (
                    <p role="alert" className="text-left text-sm text-red-600">
                        {view.error}
                    </p>
                ) : null}
                <Button type="submit" disabled={view.busy || password.length === 0} className="w-full rounded-full h-11 font-semibold">
                    {view.busy ? 'Linking…' : 'Link school sign-in'}
                </Button>
            </form>
        </AuthShell>
    );
}

export default function StudentSsoOnboardingPage() {
    return (
        <Suspense fallback={<p role="status">Loading school linking…</p>}>
            <StudentSsoOnboardingInner />
        </Suspense>
    );
}
