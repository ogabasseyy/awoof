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
import { studentSsoApiClient } from '@/lib/api-client';
import { getSessionSnapshot } from '@/lib/auth';
import { resolveStudentReturn } from '@/lib/student-return';
import {
    clearSsoAttempt,
    clearSsoHandoff,
    isSsoAttemptLive,
    parseSsoFinishResponse,
    parseSsoRestart,
    readSsoAttempt,
    saveSsoHandoff,
    ssoAttemptMatches,
    ssoFailureLoginPath,
    ssoPostLoginDestination,
    type LoginErrorCode,
    type SsoAttemptRecord,
} from '@/lib/student-login-flow';

type CompleteView =
    | { kind: 'checking' }
    | { kind: 'link_required' }
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
    const started = useRef(false);

    useEffect(() => {
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
                const kept = saveSsoHandoff(storage, {
                    handoffId: finished.handoffId,
                    handoffSecret: finished.handoffSecret,
                    expiresAt: finished.expiresAt,
                });
                clearSsoAttempt(storage);
                if (!kept) {
                    failToLogin('sso_unavailable', record.returnPath);
                    return;
                }
                // Unlinked identities stay signed out: no session is stored.
                setView({ kind: 'link_required' });
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
    }, [search, completeSsoLogin]);

    if (view.kind === 'link_required') {
        return (
            <AuthShell
                role="student"
                title="Link your school account"
                subtitle="This school sign-in is not linked to an Awoof account yet."
                footer={null}
            >
                <p role="status" className="text-left text-sm text-slate-600">
                    You are still signed out. Sign in with your password, or create an account, to link this school
                    sign-in. Linking never matches accounts by email alone.
                </p>
                <div className="mt-5 space-y-2">
                    <Button type="button" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/auth/student/login?redirect=%2Fauth%2Fstudent%2Fsso%2Fonboarding">
                            Sign in with your password
                        </Link>
                    </Button>
                    <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" asChild>
                        <Link href="/auth/student/register">Create an account</Link>
                    </Button>
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
