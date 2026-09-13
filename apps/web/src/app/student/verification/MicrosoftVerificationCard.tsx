'use client';

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Building2, ExternalLink, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import { microsoftVerificationApiClient } from '@/lib/api-client';
import { getSessionSnapshot, isCurrentSession } from '@/lib/auth';
import { isMicrosoftAuthorizationUrl, writeMicrosoftAttempt } from '@/lib/microsoft-verification';

type Snapshot = { universityId: string; providerPolicyVersion: number; noticeVersion: string; mode: 'identity_only' | 'graph_enrollment'; scopes: string[] };
type Notice = { snapshot: Snapshot; copy: { text: string } };
type History = { id: string; snapshot: Snapshot; acceptedAt: string; withdrawnAt: string | null };
type Identity = { id: string; universityId: string; universityName: string; linkedAt: string; revokedAt: string | null; status: 'connected' | 'revoked' };

type Props = {
    available: boolean;
    unavailableReason?: string;
    parentAccepted: boolean;
    setParentAccepted: (accepted: boolean) => void;
    processingGrant: () => Promise<string>;
    /** Clears the parent's stale eligibility before its next owner-status read. */
    onMicrosoftIdentityUnlinked: () => Promise<void>;
};

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4';
const button = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;
const safeError = (cause: unknown, fallback: string) => axios.isAxiosError(cause) ? cause.response?.data?.error?.message ?? fallback : fallback;

export default function MicrosoftVerificationCard({ available, unavailableReason, parentAccepted, setParentAccepted, processingGrant, onMicrosoftIdentityUnlinked }: Props) {
    const mounted = useRef(false);
    const requestSession = useRef(getSessionSnapshot());
    const historyRead = useRef(0);
    const identityRead = useRef(0);
    const current = () => mounted.current && isCurrentSession(requestSession.current);
    const beginOwnerRead = () => {
        const snapshot = requestSession.current;
        return mounted.current && snapshot.accessToken ? snapshot : null;
    };
    const [notice, setNotice] = useState<Notice | null>(null);
    const [providerAccepted, setProviderAccepted] = useState(false);
    const [history, setHistory] = useState<History[]>([]);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState('');
    const [identities, setIdentities] = useState<Identity[]>([]);
    const [identitiesLoaded, setIdentitiesLoaded] = useState(false);
    const [identityCursor, setIdentityCursor] = useState<string | null>(null);
    const [identityError, setIdentityError] = useState('');
    const [eligibilityRefreshError, setEligibilityRefreshError] = useState(false);
    const [confirmIdentityId, setConfirmIdentityId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const loadNotice = async () => {
        if (!available || !current()) return;
        try {
            const response = await microsoftVerificationApiClient.get<{ data: Notice }>('/verification/microsoft/notice');
            if (!current()) return;
            setNotice(response.data.data); setProviderAccepted(false);
        } catch {
            if (!current()) return;
            setNotice(null); setProviderAccepted(false);
            setError('The current Microsoft consent notice is unavailable. Your existing connection controls remain available below.');
        }
    };
    const loadHistory = async (cursor?: string) => {
        const snapshot = beginOwnerRead();
        if (!snapshot) return;
        const read = ++historyRead.current;
        try {
            const response = await microsoftVerificationApiClient.get<{ data: { items: History[]; nextCursor: string | null } }>('/verification/microsoft/consents', { params: cursor ? { cursor } : undefined });
            if (!mounted.current || !isCurrentSession(snapshot) || read !== historyRead.current) return;
            setHistory(previous => cursor ? [...previous, ...response.data.data.items.filter(item => !previous.some(existing => existing.id === item.id))] : response.data.data.items);
            setNextCursor(response.data.data.nextCursor); setHistoryLoaded(true); setHistoryError('');
        } catch {
            if (mounted.current && isCurrentSession(snapshot) && read === historyRead.current) setHistoryError('Microsoft consent history could not be loaded. You can retry.');
        }
    };
    const loadIdentities = async (cursor?: string) => {
        const snapshot = beginOwnerRead();
        if (!snapshot) return false;
        const read = ++identityRead.current;
        try {
            const response = await microsoftVerificationApiClient.get<{ data: { items: Identity[]; nextCursor: string | null } }>('/verification/microsoft/identities', { params: cursor ? { cursor } : undefined });
            if (!mounted.current || !isCurrentSession(snapshot) || read !== identityRead.current) return false;
            setIdentities(previous => cursor ? [...previous, ...response.data.data.items.filter(item => !previous.some(existing => existing.id === item.id))] : response.data.data.items);
            if (!cursor) setConfirmIdentityId(previous => previous && !response.data.data.items.some(item => item.id === previous) ? null : previous);
            setIdentityCursor(response.data.data.nextCursor); setIdentitiesLoaded(true); setIdentityError(''); return true;
        } catch {
            if (mounted.current && isCurrentSession(snapshot) && read === identityRead.current) setIdentityError('Microsoft connections could not be loaded. You can retry.');
            return false;
        }
    };
    const loadOwnerReads = async () => { await Promise.all([loadHistory(), loadIdentities()]); };
    useEffect(() => {
        mounted.current = true;
        queueMicrotask(() => { void loadOwnerReads(); });
        return () => { mounted.current = false; };
        // The parent remounts this card for each logical session.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        queueMicrotask(() => { void loadNotice(); });
        // Availability changes only the provider-consent notice; it must not
        // supersede an owner identity refresh already in progress.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [available]);
    const run = async (operation: () => Promise<void>) => {
        if (!current()) return;
        setBusy(true); setError(''); setMessage('');
        try { await operation(); } catch (cause) {
            if (!current()) return;
            const code = axios.isAxiosError(cause) ? cause.response?.data?.error?.code : undefined;
            if (code === 'consent_notice_changed') {
                setProviderAccepted(false); await loadNotice();
                if (current()) setMessage('The Microsoft notice changed. Please read the updated notice and accept it again.');
            } else setError(safeError(cause, 'Microsoft connection is unavailable. Please try again.'));
        } finally { if (current()) setBusy(false); }
    };
    const start = () => void run(async () => {
        if (!notice || !parentAccepted || !providerAccepted) throw new Error('Consent is required.');
        const processingGrantId = await processingGrant();
        if (!current()) return;
        const consent = await microsoftVerificationApiClient.post<{ data: { providerConsentId: string } }>('/verification/microsoft/consents', { processingGrantId, snapshot: notice.snapshot, accepted: true });
        if (!current()) return;
        const started = await microsoftVerificationApiClient.post<{ data: { attemptId: string; finishSecret: string; authorizationUrl: string } }>('/verification/microsoft/start', { processingGrantId, providerConsentId: consent.data.data.providerConsentId });
        if (!current()) return;
        if (!isMicrosoftAuthorizationUrl(started.data.data.authorizationUrl)) throw new Error('Microsoft authorization address is invalid.');
        const browserSessionId = getSessionSnapshot().browserSessionId;
        if (!browserSessionId || !current()) throw new Error('Your Awoof session changed. Start again.');
        writeMicrosoftAttempt(window.sessionStorage, { attemptId: started.data.data.attemptId, finishSecret: started.data.data.finishSecret, browserSessionId, expiresAt: Date.now() + 9 * 60 * 1000 });
        window.location.assign(started.data.data.authorizationUrl);
    });
    const unlink = (identity: Identity) => void run(async () => {
        if (confirmIdentityId !== identity.id || !current()) return;
        await microsoftVerificationApiClient.post<{ data: { identityId: string; unlinked: true; recovery: 'support_required' } }>(`/verification/microsoft/identities/${identity.id}/unlink`, {});
        if (!current()) return;
        // A successful mutation is durable even if either refresh fails. Keep
        // the local tombstone so an older pre-unlink response cannot restore it.
        ++identityRead.current;
        setIdentities(previous => previous.map(item => item.id === identity.id ? { ...item, status: 'revoked', revokedAt: item.revokedAt ?? new Date().toISOString() } : item));
        setConfirmIdentityId(null);
        setMessage('Microsoft connection removed. Your independent school-email verification was not changed. Reconnecting this revoked identity requires support.');
        const [identityRefresh, eligibilityRefresh] = await Promise.allSettled([loadIdentities(), onMicrosoftIdentityUnlinked()]);
        if (!current()) return;
        if (identityRefresh.status !== 'fulfilled' || !identityRefresh.value) setIdentityError('The connection was removed, but connection history could not be refreshed. Use Refresh to check it again.');
        if (eligibilityRefresh.status === 'rejected') setEligibilityRefreshError(true);
    });
    const retryEligibility = () => void (async () => {
        if (!current()) return;
        setBusy(true);
        try { await onMicrosoftIdentityUnlinked(); if (current()) setEligibilityRefreshError(false); }
        catch { if (current()) setEligibilityRefreshError(true); }
        finally { if (current()) setBusy(false); }
    })();
    return <section aria-labelledby="microsoft-heading" className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white">
        <div className="p-6 sm:p-8"><div className="flex gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><Building2 aria-hidden="true" className="h-5 w-5" /></span><div><p className="text-xs font-bold uppercase tracking-[.14em] text-slate-500">Optional connection</p><h2 id="microsoft-heading" className="mt-1 text-xl font-semibold">Connect a Microsoft school account</h2></div></div><p className="mt-4 max-w-2xl text-sm leading-6 text-slate-600">Connecting an account confirms access to that account. It does not by itself confirm current enrollment. School email verification remains a separate option.</p></div>
        {error && <p role="alert" className="mx-6 mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-800 sm:mx-8">{error}</p>}{message && <p role="status" className="mx-6 mb-4 rounded-xl bg-blue-50 p-4 text-sm text-blue-900 sm:mx-8">{message}</p>}
        {available && notice ? <div className="space-y-4 border-t border-slate-100 p-6 sm:p-8"><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700"><input aria-label="Accept verification processing consent" className={`mt-1 h-4 w-4 accent-blue-700 ${focus}`} type="checkbox" checked={parentAccepted} disabled={busy} onChange={event => setParentAccepted(event.target.checked)} /><span>Accept verification processing: this is required before Awoof can request the provider connection.</span></label><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700"><input aria-label="Accept Microsoft provider consent" className={`mt-1 h-4 w-4 accent-blue-700 ${focus}`} type="checkbox" checked={providerAccepted} disabled={busy} onChange={event => setProviderAccepted(event.target.checked)} /><span>{notice.copy.text}</span></label><button type="button" disabled={busy || !parentAccepted || !providerAccepted} className={`${button} w-full sm:w-auto`} onClick={start}>{busy ? 'Preparing connection…' : <>Continue with Microsoft<ExternalLink aria-hidden="true" className="h-4 w-4" /></>}</button></div> : <p className="mx-6 mb-6 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600 sm:mx-8">{unavailableReason || 'Microsoft verification is not currently available. Your school email option is unaffected.'}</p>}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-5 sm:px-8"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Microsoft connections</h3><button type="button" className={`min-h-11 text-sm font-semibold text-blue-700 ${focus}`} disabled={busy} onClick={() => void loadIdentities()}><RefreshCw aria-hidden="true" className="mr-1 inline h-4 w-4" />Refresh</button></div>{identityError && <p role="alert" className="mt-3 text-sm text-red-800">{identityError}</p>}{eligibilityRefreshError && <div role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">The connection was removed, but current eligibility could not be refreshed. <button type="button" className={`font-semibold underline ${focus}`} disabled={busy} onClick={retryEligibility}>Retry current eligibility</button></div>}{!identitiesLoaded && !identityError ? <p role="status" className="mt-3 text-sm text-slate-600">Loading Microsoft connections…</p> : identitiesLoaded && identities.length === 0 ? <p className="mt-3 text-sm text-slate-600">No Microsoft connections recorded.</p> : <ul className="mt-3 space-y-3">{identities.map(item => <li key={item.id} className="rounded-xl bg-white p-4 text-sm text-slate-700"><p><ShieldCheck aria-hidden="true" className="mr-1 inline h-4 w-4 text-blue-700" />{item.status === 'connected' ? 'Connected' : 'Removed'} — {item.universityName}</p><p className="mt-1 text-slate-500">Connected {new Date(item.linkedAt).toLocaleDateString()}</p>{item.status === 'connected' && (confirmIdentityId === item.id ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3"><p className="text-sm leading-6 text-red-900">Remove this Microsoft connection? This removes dependent Microsoft eligibility, leaves school-email verification unchanged, and requires support to reconnect this revoked identity.</p><div className="mt-3 flex gap-3"><button type="button" className={`min-h-11 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 ${focus}`} disabled={busy} onClick={() => unlink(item)}>Unlink Microsoft</button><button type="button" className={`min-h-11 rounded-lg px-3 text-sm font-semibold text-slate-700 ${focus}`} disabled={busy} onClick={() => setConfirmIdentityId(null)}>Cancel</button></div></div> : <button type="button" className={`mt-2 min-h-11 text-sm font-semibold text-slate-700 underline ${focus}`} disabled={busy} onClick={() => { if (current()) setConfirmIdentityId(item.id); }}><Unlink aria-hidden="true" className="mr-1 inline h-4 w-4" />Unlink Microsoft connection</button>)}</li>)}</ul>}{identityCursor && <button type="button" className={`mt-4 min-h-11 text-sm font-semibold text-blue-700 underline ${focus}`} disabled={busy} onClick={() => void loadIdentities(identityCursor)}>Load more Microsoft connections</button>}</div>
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-5 sm:px-8"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Microsoft consent history</h3><button type="button" className={`min-h-11 text-sm font-semibold text-blue-700 ${focus}`} disabled={busy} onClick={() => void loadHistory()}><RefreshCw aria-hidden="true" className="mr-1 inline h-4 w-4" />Refresh</button></div>{historyError && <p role="alert" className="mt-3 text-sm text-red-800">{historyError}</p>}{!historyLoaded && !historyError ? <p role="status" className="mt-3 text-sm text-slate-600">Loading Microsoft consent history…</p> : historyLoaded && history.length === 0 ? <p className="mt-3 text-sm text-slate-600">No Microsoft consent grants recorded.</p> : <ul className="mt-3 space-y-3">{history.map(item => <li key={item.id} className="rounded-xl bg-white p-4 text-sm text-slate-700"><p><ShieldCheck aria-hidden="true" className="mr-1 inline h-4 w-4 text-blue-700" />{item.withdrawnAt ? 'Withdrawn' : 'Active'} — accepted {new Date(item.acceptedAt).toLocaleDateString()}</p>{!item.withdrawnAt && <button type="button" className={`mt-2 min-h-11 text-sm font-semibold text-slate-700 underline ${focus}`} disabled={busy} onClick={() => void run(async () => { await microsoftVerificationApiClient.post(`/verification/microsoft/consents/${item.id}/withdraw`, {}); if (!current()) return; await loadHistory(); if (current()) setMessage('Microsoft provider consent withdrawn. Independent email evidence was not changed.'); })}>Withdraw Microsoft consent</button>}</li>)}</ul>}{nextCursor && <button type="button" className={`mt-4 min-h-11 text-sm font-semibold text-blue-700 underline ${focus}`} disabled={busy} onClick={() => void loadHistory(nextCursor)}>Load more Microsoft consents</button>}</div>
    </section>;
}
