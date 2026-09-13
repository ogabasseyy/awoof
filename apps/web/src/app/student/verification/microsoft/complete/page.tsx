'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { microsoftVerificationApiClient, default as apiClient } from '@/lib/api-client';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';
import { clearMicrosoftAttempt, readMicrosoftAttempt } from '@/lib/microsoft-verification';
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
            await reloadEligibility(session);
        } catch (cause) {
            if (!isCurrentSession(session)) return;
            const terminal = axios.isAxiosError(cause) && typeof cause.response?.status === 'number' && cause.response.status >= 400 && cause.response.status < 500;
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
    return <main className="min-h-screen bg-[#F4F7FD] px-4 py-12 text-slate-900"><section className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"><p className="text-xs font-bold uppercase tracking-[.16em] text-blue-700">Microsoft connection</p>{loading ? <><RefreshCw aria-hidden="true" className="mt-6 h-8 w-8 animate-spin text-blue-700" /><h1 className="mt-5 text-2xl font-semibold">Completing your connection…</h1><p role="status" className="mt-3 text-sm leading-6 text-slate-600">We are checking the account connection and your current eligibility separately.</p></> : result ? <><CheckCircle2 aria-hidden="true" className="mt-6 h-9 w-9 text-emerald-700" /><h1 className="mt-5 text-2xl font-semibold">University account connected</h1><p role="status" className="mt-3 text-sm leading-6 text-slate-700">Your Microsoft account is linked. {result.enrollment === 'eligible' ? 'Current enrollment was confirmed.' : result.enrollment === 'denied' ? 'Current enrollment was not confirmed.' : result.enrollment === 'unconfirmed' ? 'Current enrollment is still unconfirmed.' : 'This connection did not check current enrollment.'}</p>{eligibility ? <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">Current Awoof eligibility: <strong>{eligibility.eligible ? 'eligible' : 'not currently eligible'}</strong>{eligibility.reason ? ` — ${eligibility.reason}` : ''}.</p> : <><p role="status" className="mt-3 text-sm text-slate-600">{statusError || 'Current eligibility is loading.'}</p>{statusError && <button type="button" onClick={() => void reloadEligibility()} className="mt-3 min-h-11 text-sm font-semibold text-blue-700 underline">Retry eligibility check</button>}</>}<Link href="/student/verification" className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-[#1D4ED8] px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">Return to student verification</Link></> : <><ShieldAlert aria-hidden="true" className="mt-6 h-8 w-8 text-amber-700" /><h1 className="mt-5 text-2xl font-semibold">Connection needs attention</h1><p role="alert" className="mt-3 text-sm leading-6 text-slate-700">{finishError}</p><div className="mt-6 flex flex-wrap gap-3">{canRetryFinish && <button type="button" onClick={() => void complete()} className="min-h-12 rounded-xl bg-[#1D4ED8] px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">Retry completion</button>}<Link className="inline-flex min-h-12 items-center rounded-xl px-4 text-sm font-semibold text-blue-700 underline" href="/student/verification">Start again</Link>{finishError === 'The Microsoft connection was not completed. You can still verify using your school email.' && <Link className="inline-flex min-h-12 items-center rounded-xl px-4 text-sm font-semibold text-blue-700 underline" href="/student/verification">Use school email verification</Link>}</div></>}</section></main>;
}

export default function MicrosoftCompletePage() { const { user } = useAuth(); const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverGeneration); return <ProtectedRoute requiredRole="student">{user?.role === 'student' && <Complete key={`${generation}:${user.id}`} />}</ProtectedRoute>; }
