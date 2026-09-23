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
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { studentSsoApiClient } from '@/lib/api-client';
import { getSessionSnapshot } from '@/lib/auth';
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

function StudentSsoOnboardingInner() {
    const [view, setView] = useState<OnboardingView>({ kind: 'checking' });
    const [password, setPassword] = useState('');
    const startedRef = useRef(false);
    const reauthFailures = useRef(0);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        const handoff = readSsoHandoff(tabStorage());
        if (!handoff || !isSsoAttemptLive(handoff, Date.now())) {
            forgetHandoff();
            setView({ kind: 'no_handoff' });
            return;
        }
        setView({ kind: 'ready', handoff, error: null, busy: false });
    }, []);

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
