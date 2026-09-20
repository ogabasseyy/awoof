'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, ChevronLeft, Clock3, ShieldAlert, Timer } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import { Button } from '@/components/ui/button';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import { primaryNavItems, secondaryNavItems } from '../../adminNav';

type DiagnosticStage = 'started' | 'callback_received' | 'token_validated' | 'education_response' | 'policy_decision' | 'finished';
type DiagnosticOutcome = 'success' | 'failure' | 'unknown';
type DiagnosticReason = 'none' | 'permission_required' | 'invalid_identity' | 'missing_data' | 'upstream_unavailable' | 'policy_denied' | 'expired' | 'cancelled';

type TimelineEvent = {
    stage: DiagnosticStage;
    outcome: DiagnosticOutcome;
    reason: DiagnosticReason;
    httpStatus: number | null;
    durationMs: number;
    recordedAt: string;
};

type InstitutionAggregate = {
    institutionId: string;
    institutionName: string;
    finishedAttemptCount: number;
    averageFinishedRequestDurationMs: number | null;
    p95FinishedRequestDurationMs: number | null;
    incompleteAttempts: number;
    failureCategories: Array<{ category: Exclude<DiagnosticReason, 'none'>; eventCount: number }>;
};

type DiagnosticsData = {
    timeline: TimelineEvent[];
    aggregateWindow: 'last_30_days';
    measuredAt: string;
    windowStartedAt: string;
    aggregates: InstitutionAggregate[];
};

function sessionGeneration() {
    return getSessionSnapshot().generation;
}

function serverSessionGeneration() {
    return 0;
}

function stageLabel(stage: DiagnosticStage): string {
    return {
        started: 'Attempt started',
        callback_received: 'Callback received',
        token_validated: 'Token validated',
        education_response: 'Education check completed',
        policy_decision: 'Policy decision recorded',
        finished: 'Attempt finished',
    }[stage];
}

function outcomeStyle(outcome: DiagnosticOutcome): string {
    if (outcome === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    if (outcome === 'failure') return 'border-rose-200 bg-rose-50 text-rose-800';
    return 'border-amber-200 bg-amber-50 text-amber-800';
}

function nextAction(event: TimelineEvent): string {
    if (event.reason === 'permission_required') return 'Review the approved institution permission and retry only after it is corrected.';
    if (event.reason === 'invalid_identity') return 'Ask the student to use the institution account that matches the approved policy.';
    if (event.reason === 'missing_data' || event.reason === 'upstream_unavailable') return 'Use the school-email alternative; no new eligibility was created.';
    if (event.reason === 'expired' || event.reason === 'cancelled') return 'The attempt ended safely. Start a new verification only with current consent.';
    if (event.reason === 'policy_denied') return 'Review the current policy before any new verification attempt.';
    return event.outcome === 'success' ? 'No administrator action is required.' : 'Use the school-email alternative while the issue is reviewed.';
}

function displayDuration(value: number | null): string {
    return value === null ? 'No finished duration yet' : `${Math.round(value)} ms`;
}

export default function AdminVerificationDiagnosticsPage() {
    const { user } = useAuth();
    const params = useParams<{ correlationId?: string | string[] }>();
    const correlationId = typeof params.correlationId === 'string' ? params.correlationId : '';
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverSessionGeneration);

    return (
        <ProtectedRoute requiredRole="admin">
            <AdminVerificationDiagnosticsDetail key={`${generation}:${user?.id}:${correlationId}`} correlationId={correlationId} />
        </ProtectedRoute>
    );
}

function AdminVerificationDiagnosticsDetail({ correlationId }: { correlationId: string }) {
    const { user, logout } = useAuth();
    const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<'unavailable' | 'not_found' | null>(null);
    const active = useRef(false);
    const requestSequence = useRef(0);

    const load = useCallback(async () => {
        if (!active.current || !correlationId) return;
        // Capture authority at dispatch. A stale snapshot may complete its
        // read, but it cannot update UI after session replacement.
        const requestSession = getSessionSnapshot();
        const sequence = ++requestSequence.current;
        const current = () => active.current && sequence === requestSequence.current && isCurrentSession(requestSession);
        try {
            const response = await apiClient.get(`/admin/verification-diagnostics/${correlationId}`);
            if (!current()) return;
            setDiagnostics(response.data.data as DiagnosticsData);
            setError(null);
        } catch (requestError: unknown) {
            if (!current()) return;
            const status = typeof requestError === 'object' && requestError !== null
                && 'response' in requestError
                && typeof requestError.response === 'object' && requestError.response !== null
                && 'status' in requestError.response
                && requestError.response.status === 404;
            setError(status ? 'not_found' : 'unavailable');
        } finally {
            if (current()) setLoading(false);
        }
    }, [correlationId]);

    const retry = () => {
        if (!active.current || !isCurrentSession(getSessionSnapshot())) return;
        setLoading(true);
        setError(null);
        void load();
    };

    useEffect(() => {
        active.current = true;
        // State updates are fenced after the request settles, because a logout
        // or session replacement can happen while this read is in flight.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
        return () => {
            active.current = false;
            requestSequence.current += 1;
        };
    }, [load]);

    useEffect(() => subscribeSessionChanges(() => {
        if (!active.current) return;
        // A replacement session must issue its own read. The earlier response
        // is still fenced by its captured requestSession and sequence number.
        setDiagnostics(null);
        setError(null);
        setLoading(true);
        void load();
    }), [load]);

    return (
        <DashboardLayout
            navItems={primaryNavItems}
            secondaryNavItems={secondaryNavItems}
            pageTitle="Verification diagnostics"
            user={{ name: user?.email ?? 'Admin', email: user?.email, roleLabel: 'Admin', profileHref: '/admin/settings' }}
            onLogout={logout}
        >
            <Button asChild variant="ghost" size="sm" className="mb-4">
                <Link href="/admin/universities">
                    <ChevronLeft className="mr-2 h-4 w-4" />
                    Back to universities
                </Link>
            </Button>

            <section className="max-w-5xl space-y-6">
                <div className="border-b border-slate-200 pb-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Operations only</p>
                    <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Redacted verification timeline</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">This view contains fixed diagnostic stages and safe aggregate signals. It never displays a student profile, tenant identity, provider response, token, URL, or authorization code.</p>
                </div>

                {loading ? <p className="text-sm text-slate-500">Loading redacted diagnostic timeline…</p> : null}
                {!loading && error === 'not_found' ? <DiagnosticNotice title="Diagnostic timeline not found" detail="The requested diagnostic is unavailable. No student or provider details are shown." /> : null}
                {!loading && error === 'unavailable' ? <DiagnosticNotice title="Diagnostic timeline is unavailable" detail="Check current administrator access. No verification decision was changed." retry={retry} /> : null}
                {!loading && !error && diagnostics?.timeline.length === 0 ? <DiagnosticNotice title="No timeline events available" detail="No redacted stages were persisted for this diagnostic." /> : null}

                {!loading && !error && diagnostics && diagnostics.timeline.length > 0 ? <>
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        <span className="font-semibold">Interpret incomplete carefully.</span> An incomplete attempt is an expired start with no callback; it is not an enrollment denial and does not create eligibility.
                    </div>
                    <ol className="space-y-3" aria-label="Verification diagnostic timeline">
                        {diagnostics.timeline.map((event, index) => <li key={`${event.recordedAt}:${event.stage}:${index}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="flex gap-3">
                                    {event.outcome === 'success' ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" /> : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />}
                                    <div>
                                        <h2 className="font-semibold text-slate-900">{stageLabel(event.stage)}</h2>
                                        <p className="mt-1 text-sm text-slate-600">{nextAction(event)}</p>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2 text-xs font-medium">
                                    <span className={`rounded-full border px-2.5 py-1 ${outcomeStyle(event.outcome)}`}>{event.outcome}</span>
                                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700">{event.reason.replaceAll('_', ' ')}</span>
                                </div>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
                                <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{new Date(event.recordedAt).toLocaleString()}</span>
                                <span className="inline-flex items-center gap-1"><Timer className="h-3.5 w-3.5" aria-hidden="true" />{Math.round(event.durationMs)} ms</span>
                                {event.httpStatus !== null ? <span>Safe HTTP status: {event.httpStatus}</span> : null}
                            </div>
                        </li>)}</ol>

                    <section className="rounded-xl border border-slate-200 bg-slate-50 p-5" aria-labelledby="aggregate-heading">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <h2 id="aggregate-heading" className="font-semibold text-slate-900">Configured-institution operational aggregates</h2>
                                <p className="mt-1 text-sm text-slate-600">Fixed 30-day window ending {new Date(diagnostics.measuredAt).toLocaleString()}. Finished request durations are not per-stage or end-to-end attempt timings.</p>
                            </div>
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                            {diagnostics.aggregates.map((aggregate) => <article key={aggregate.institutionId} className="rounded-lg border border-slate-200 bg-white p-4">
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Configured institution</p>
                                <h3 className="mt-1 font-semibold text-slate-900">{aggregate.institutionName}</h3>
                                <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
                                    <div><dt className="text-slate-500">Finished attempts</dt><dd className="mt-1 font-semibold text-slate-900">{aggregate.finishedAttemptCount}</dd></div>
                                    <div><dt className="text-slate-500">Incomplete attempts</dt><dd className="mt-1 font-semibold text-slate-900">{aggregate.incompleteAttempts}</dd></div>
                                    <div><dt className="text-slate-500">Average finished request</dt><dd className="mt-1 font-semibold text-slate-900">{displayDuration(aggregate.averageFinishedRequestDurationMs)}</dd></div>
                                    <div><dt className="text-slate-500">P95 finished request</dt><dd className="mt-1 font-semibold text-slate-900">{displayDuration(aggregate.p95FinishedRequestDurationMs)}</dd></div>
                                </dl>
                                {aggregate.failureCategories.length > 0 ? <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-600">Failure categories: {aggregate.failureCategories.map((category) => `${category.category.replaceAll('_', ' ')} (${category.eventCount})`).join(', ')}</p> : <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">No redacted failure categories were recorded in this window.</p>}
                            </article>)}
                        </div>
                    </section>
                </> : null}
            </section>
        </DashboardLayout>
    );
}

function DiagnosticNotice({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
    return <div className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-5 text-slate-700">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        <div><h2 className="font-semibold text-slate-900">{title}</h2><p className="mt-1 text-sm">{detail}</p>{retry ? <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retry}>Retry timeline</Button> : null}</div>
    </div>;
}
