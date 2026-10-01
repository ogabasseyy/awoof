'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { MicrosoftCallbackShell } from '@/components/auth/MicrosoftCallbackShell';
import ProtectedRoute from '@/components/ProtectedRoute';
import { microsoftVerificationApiClient, default as apiClient } from '@/lib/api-client';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';
import { clearMicrosoftAttempt, isTerminalFinishStatus, readMicrosoftAttempt } from '@/lib/microsoft-verification';
import { useAuth } from '@/contexts/AuthContext';

type Finish = { accountLinked: true; enrollment: 'not_checked' | 'eligible' | 'unconfirmed' | 'denied' };
type Eligibility = { eligible: boolean; reason?: string };
const sessionGeneration = () => getSessionSnapshot().generation;
const serverGeneration = () => -1;

function Complete() {
    const [result, setResult] = useState<Finish | null>(null);
    const [eligibility, setEligibility] = useState<Eligibility | null>(null);
    const [finishError, setFinishError] = useState('');
    const [statusError, setStatusError] = useState('');
    const [canRetryFinish, setCanRetryFinish] = useState(false);
    const [loading, setLoading] = useState(true);
    const startedInitialCompletion = useRef(false);
    const reloadEligibility = async (session = getSessionSnapshot()) => {
        setStatusError('');
        try {
            const status = await apiClient.get<{ data: { eligibility: Eligibility } }>('/verification/status');
            if (isCurrentSession(session)) setEligibility(status.data.data.eligibility);
        } catch {
            if (isCurrentSession(session)) setStatusError('Current eligibility could not be reloaded. Visit verification to check it.');
        }
    };
    const complete = async () => {
        setLoading(true); setFinishError(''); setCanRetryFinish(false);
        const session = getSessionSnapshot();
        const attempt = readMicrosoftAttempt(window.sessionStorage);
        const parameters = new URLSearchParams(window.location.search);
        const returnedAttempt = parameters.get('attempt');
        const matchingAttempt = Boolean(attempt && session.browserSessionId
            && attempt.browserSessionId === session.browserSessionId
            && returnedAttempt === attempt.attemptId
            && isCurrentSession(session));
        if (!matchingAttempt || !attempt) {
            // A later login makes an earlier tab record obsolete. Do not
            // remove a current-session attempt merely because an untrusted
            // query names a different attempt.
            if (attempt && session.browserSessionId && attempt.browserSessionId !== session.browserSessionId && isCurrentSession(session)) {
                clearMicrosoftAttempt(window.sessionStorage);
            }
            setFinishError('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.'); setLoading(false); return;
        }
        if (parameters.get('outcome') === 'connection_not_completed') {
            // The server emits this only after the callback has bound state and
            // its Secure cookie. The query itself is never authorization; the
            // tab record and durable browser-session fence must still match.
            clearMicrosoftAttempt(window.sessionStorage);
            setFinishError('The Microsoft connection was not completed. You can still verify using your school email.');
            setLoading(false); return;
        }
        try {
            const response = await microsoftVerificationApiClient.post<{ data: Finish }>('/verification/microsoft/finish', { attemptId: attempt.attemptId, finishSecret: attempt.finishSecret });
            if (!isCurrentSession(session)) return;
            clearMicrosoftAttempt(window.sessionStorage);
            setResult(response.data.data);
            // The link is committed; render it before the independent
            // eligibility refresh so a slow status endpoint cannot hold the
            // page on its loading state indefinitely.
            if (isCurrentSession(session)) setLoading(false);
            await reloadEligibility(session);
        } catch (cause) {
            if (!isCurrentSession(session)) return;
            const terminal = axios.isAxiosError(cause) && typeof cause.response?.status === 'number' && isTerminalFinishStatus(cause.response.status);
            if (terminal) {
                try { clearMicrosoftAttempt(window.sessionStorage); } catch { /* Restart is the safe path. */ }
                setFinishError('This Microsoft connection can no longer be completed. Start again from student verification.');
            } else {
                setCanRetryFinish(true);
                setFinishError('We could not complete the Microsoft connection yet. You can retry while this tab and Awoof session remain active.');
            }
        } finally { if (isCurrentSession(session)) setLoading(false); }
    };
    useEffect(() => {
        if (startedInitialCompletion.current) return;
        startedInitialCompletion.current = true;
        void complete(); // Full redirect completion only; a retry is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <MicrosoftCallbackShell
            label="Microsoft connection"
            title={loading ? 'Completing your connection…' : result ? 'University account connected' : 'Connection needs attention'}
            status={loading ? 'loading' : result ? 'connected' : 'attention'}
        >
            {loading ? (
                <p role="status">We are checking the account connection and your current eligibility separately.</p>
            ) : result ? (
                <>
                    <p role="status">
                        Your Microsoft account is linked. {result.enrollment === 'eligible' ? 'Current enrollment was confirmed.' : result.enrollment === 'denied' ? 'Current enrollment was not confirmed.' : result.enrollment === 'unconfirmed' ? 'Current enrollment is still unconfirmed.' : 'This connection did not check current enrollment.'}
                    </p>
                    {eligibility ? (
                        <p className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-slate-700">
                            Current Awoof eligibility: <strong>{eligibility.eligible ? 'eligible' : 'not currently eligible'}</strong>
                            {eligibility.reason && <> — {eligibility.reason}</>}
                        </p>
                    ) : (
                        <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                            <p role="status">{statusError || 'Current eligibility is loading.'}</p>
                            {statusError && (
                                <button type="button" onClick={() => void reloadEligibility()} className="mt-2 min-h-11 rounded-lg font-semibold text-[#1D4ED8] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
                                    Retry eligibility check
                                </button>
                            )}
                        </div>
                    )}
                    <Link href="/student/verification" className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[#1D4ED8] px-5 text-center font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">
                        Return to student verification
                    </Link>
                </>
            ) : (
                <>
                    <p role="alert">{finishError}</p>
                    <div className="mt-6 flex flex-col gap-3">
                        {canRetryFinish && (
                            <button type="button" onClick={() => void complete()} className="min-h-12 rounded-full bg-[#1D4ED8] px-5 font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">
                                Retry completion
                            </button>
                        )}
                        <Link className="inline-flex min-h-12 items-center justify-center rounded-full border border-blue-200 px-4 font-semibold text-[#1D4ED8] hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4" href="/student/verification">
                            Start again
                        </Link>
                        {finishError === 'The Microsoft connection was not completed. You can still verify using your school email.' && (
                            <Link className="inline-flex min-h-12 items-center justify-center rounded-full px-4 text-center font-semibold text-[#1D4ED8] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4" href="/student/verification">
                                Use school email verification
                            </Link>
                        )}
                    </div>
                </>
            )}
        </MicrosoftCallbackShell>
    );
}

export default function MicrosoftCompletePage() { const { user } = useAuth(); const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverGeneration); return <ProtectedRoute requiredRole="student">{user?.role === 'student' && <Complete key={`${generation}:${user.id}`} />}</ProtectedRoute>; }
