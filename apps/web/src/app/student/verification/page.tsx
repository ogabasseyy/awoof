'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import axios from 'axios';
import ProtectedRoute from '@/components/ProtectedRoute';
import apiClient from '@/lib/api-client';
import { useAuth } from '@/contexts/AuthContext';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';

type Consent = { id: string; kind: 'processing' | 'disclosure'; acceptedAt: string; withdrawnAt: string | null; origin?: string | null; purpose?: string | null };
const sessionGeneration = () => getSessionSnapshot().generation;
const serverGeneration = () => -1;

type VerificationStatus = {
    emailDomainApproved: boolean;
    mailboxConfirmed: boolean;
    email: string;
    universityId: string | null;
    eligibility: { eligible: boolean; reason?: string };
    notices: { verification: { version: string; text: string } };
};

function VerificationForm() {
    const [session] = useState(getSessionSnapshot);
    const mounted = useRef(false);
    const statusRead = useRef(0);
    const consentRead = useRef(0);
    const pendingConsents = useRef(new Map<string, Consent>());
    const isCurrent = () => mounted.current && isCurrentSession(session);
    async function currentRequest<T>(request: () => Promise<T>): Promise<T> {
        if (!isCurrent()) throw new Error('Session changed');
        const result = await request();
        if (!isCurrent()) throw new Error('Session changed');
        return result;
    }
    const [consents, setConsents] = useState<Consent[]>([]);
    const [consentsLoaded, setConsentsLoaded] = useState(false);
    const [consentError, setConsentError] = useState('');
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [status, setStatus] = useState<VerificationStatus | null>(null);
    const [methods, setMethods] = useState<Array<{ methodType: string; isAvailable: boolean }> | null>(null);
    const [accepted, setAccepted] = useState(false);
    const [mailboxConfirmed, setMailboxConfirmed] = useState(false);
    const [grant, setGrant] = useState('');
    const [challenge, setChallenge] = useState('');
    const [otp, setOtp] = useState('');
    const [registration, setRegistration] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [retryAt, setRetryAt] = useState(0);
    async function loadConsents(cursor?: string) {
        const read = ++consentRead.current;
        try {
            const response = await currentRequest(() => apiClient.get<{ data: { items: Consent[]; nextCursor: string | null } }>('/verification/consents', { params: cursor ? { cursor } : undefined }));
            if (read !== consentRead.current) return;
            for (const consent of response.data.data.items) pendingConsents.current.delete(consent.id);
            const localConsents = [...pendingConsents.current.values()];
            setConsents((previous) => {
                // A locally created grant can also occur on a later UUID page.
                // Keep one control per grant, using the latest server value.
                const byId = new Map((cursor ? previous : []).map((consent) => [consent.id, consent]));
                for (const consent of localConsents) byId.set(consent.id, consent);
                for (const consent of response.data.data.items) byId.set(consent.id, consent);
                return [...byId.values()];
            });
            setNextCursor(response.data.data.nextCursor);
            setConsentsLoaded(true); setConsentError('');
        } catch (cause) {
            if (!isCurrent() || read !== consentRead.current) return;
            setConsentError('Unable to load consent history. Try refreshing your consent history.');
            throw cause;
        }
    }
    async function loadStatus() {
        const read = ++statusRead.current;
        const isLatest = () => isCurrent() && read === statusRead.current;
        try {
            const response = await currentRequest(() => apiClient.get<{ data: VerificationStatus }>('/verification/status'));
            if (!isLatest()) return;
            setStatus(response.data.data);
            setMailboxConfirmed(response.data.data.mailboxConfirmed === true);
            setMethods(null);
            if (response.data.data.universityId) {
                const available = await currentRequest(() => apiClient.get(`/verification/methods/${response.data.data.universityId}`)).catch(() => null);
                if (!isLatest()) return;
                setMethods(available?.data.data.methods ?? []);
            }
        } catch (cause) {
            if (isLatest()) throw cause;
        }
    }
    useEffect(() => {
        mounted.current = true;
        void loadStatus().catch(() => { if (isCurrent()) setError('Unable to load verification. Please reload this page.'); });
        void loadConsents().catch(() => undefined);
        return () => { mounted.current = false; };
        // The parent remounts this complete form for every logical session.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    async function run(operation: () => Promise<void>) {
        if (!isCurrent()) return;
        setBusy(true); setError(''); setMessage('');
        try { await operation(); }
        catch (cause) {
            if (!isCurrent()) return;
            setError(axios.isAxiosError(cause) ? cause.response?.data?.error?.message ?? 'Verification is unavailable. Please try again.' : 'Verification is unavailable. Please try again.');
        } finally { if (isCurrent()) setBusy(false); }
    }
    async function processingGrant() {
        if (grant) return grant;
        if (!status?.universityId || !accepted) throw new Error('Consent required');
        const response = await currentRequest(() => apiClient.post('/verification/initiate', {
            universityId: status.universityId, accepted: true, noticeVersion: status.notices.verification.version,
        }));
        const id: string = response.data.data.processingGrantId;
        const consent: Consent = { id, kind: 'processing', acceptedAt: new Date().toISOString(), withdrawnAt: null };
        // Keep the pending first page and its pagination cursor authoritative.
        // Retain this grant until a server page acknowledges it by ID.
        pendingConsents.current.set(id, consent);
        setConsents((previous) => [consent, ...previous.filter((item) => item.id !== id)]);
        setGrant(id); return id;
    }
    const emailAvailable = status?.emailDomainApproved === true && methods?.some((method) => method.methodType === 'email' && method.isAvailable) === true;
    const registrationAvailable = methods?.some((method) => method.methodType === 'registration' && method.isAvailable) === true;
    return <main className="mx-auto max-w-lg space-y-5 p-6">
        <Link href="/student/profile" className="underline">Back to profile</Link>
        <h1 className="text-2xl font-semibold">Student verification</h1>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {message && <p role="status">{message}</p>}
        {!status ? <p>Loading verification…</p> : status.eligibility.eligible ? <>
            <p role="status">Your student eligibility is current.</p>
            <Link href="/marketplace" className="underline">Browse student offers</Link>
        </> : !status.universityId ? <p>Your school profile is incomplete. Contact support to update your school before verifying.</p> : <>
            <p>Confirm your school email, {status.email}, to renew your verification. Some schools also require a current enrollment check.</p>
            <label className="flex gap-3"><input type="checkbox" checked={accepted} disabled={busy || Boolean(grant)} onChange={(event) => setAccepted(event.target.checked)} />{status.notices.verification.text}</label>
            <button type="button" className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50" disabled={busy || !accepted || !emailAvailable} onClick={() => void run(async () => {
                if (Date.now() < retryAt) { setMessage('Please wait before requesting another code.'); return; }
                const processingGrantId = await processingGrant();
                const response = await currentRequest(() => apiClient.post('/verification/email/request', { processingGrantId }));
                setChallenge(response.data.data.challengeId); setOtp('');
                setRetryAt(Date.parse(response.data.data.resendAvailableAt));
                setMessage('Check your school email for a six-digit code.');
            })}>{busy ? 'Please wait…' : challenge ? 'Send another code' : 'Send verification code'}</button>
            {methods !== null && !emailAvailable && <p>School email verification is currently unavailable. Please contact support.</p>}
            {challenge && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
                await currentRequest(() => apiClient.post('/verification/email/confirm', { challengeId: challenge, otp }));
                setMailboxConfirmed(true); setChallenge(''); setOtp(''); await loadStatus(); setMessage('School email confirmed.');
            }); }}>
                <label className="block">Email code<input className="block rounded border p-2" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
                <button disabled={busy || otp.length !== 6} className="underline">Confirm email</button>
            </form>}
            {registrationAvailable && mailboxConfirmed ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
                const processingGrantId = await processingGrant();
                const response = await currentRequest(() => apiClient.post('/verification/registration', { processingGrantId, registrationNumber: registration }));
                await loadStatus();
                setMessage(response.data.data.eligibility.eligible ? 'Enrollment confirmed.' : 'Enrollment could not be confirmed. Check your registration number or contact support.');
            }); }}>
                <h2 className="font-semibold">Enrollment check</h2>
                <label className="block">Registration number<input className="block rounded border p-2" value={registration} maxLength={100} required onChange={(event) => setRegistration(event.target.value)} /></label>
                <button disabled={busy || !accepted || !registration.trim()} className="underline">Check enrollment</button>
            </form> : <p>{registrationAvailable ? 'Confirm your school email above before checking enrollment.' : 'Enrollment verification is not currently available for your school.'}</p>}
        </>}
        <section aria-labelledby="consent-heading" className="space-y-3 border-t pt-4">
            <h2 id="consent-heading" className="text-lg font-semibold">Verification privacy and consent</h2>
            <p>You can withdraw consent even when your verification has expired. Withdrawing verification consent may end your student eligibility.</p>
            {consentError && <p role="alert">{consentError}</p>}
            {!consentsLoaded && !consentError && <p>Loading consent history…</p>}
            {consentsLoaded && consents.length === 0 && <p>No verification consents recorded.</p>}
            {consents.map((consent) => <div key={consent.id} className="space-y-1">
                <p>{consent.kind === 'processing' ? 'Verification processing' : 'Merchant disclosure'} consent — accepted {new Date(consent.acceptedAt).toLocaleDateString()}</p>
                {consent.kind === 'disclosure' && <p>{consent.origin} — {consent.purpose}</p>}
                {consent.withdrawnAt ? <p>Withdrawn</p> : <button type="button" disabled={busy} className="underline" onClick={() => void run(async () => {
                    await currentRequest(() => apiClient.delete(`/verification/consents/${consent.id}`));
                    ++statusRead.current;
                    ++consentRead.current;
                    pendingConsents.current.delete(consent.id);
                    setConsents((previous) => previous.map((item) => item.id === consent.id ? { ...item, withdrawnAt: new Date().toISOString() } : item));
                    setGrant(''); setChallenge(''); setOtp(''); setRegistration(''); setAccepted(false); setRetryAt(0);
                    setStatus(null); setMailboxConfirmed(false); setMethods(null);
                    setMessage('Consent withdrawn.');
                    void loadConsents().catch(() => undefined);
                    await loadStatus();
                })}>{consent.kind === 'processing' ? 'Withdraw verification consent' : 'Withdraw merchant disclosure consent'}</button>}
            </div>)}
            <button type="button" disabled={busy} className="underline" onClick={() => void run(() => loadConsents())}>Refresh consent history</button>
            {nextCursor && <button type="button" disabled={busy} className="underline" onClick={() => void run(() => loadConsents(nextCursor))}>Load more consents</button>}
        </section>
    </main>;
}

export default function StudentVerificationPage() {
    const { user } = useAuth();
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverGeneration);
    return <ProtectedRoute requiredRole="student">{user?.role === 'student' && <VerificationForm key={`${generation}:${user.id}`} />}</ProtectedRoute>;
}
