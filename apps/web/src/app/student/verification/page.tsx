'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import ProtectedRoute from '@/components/ProtectedRoute';
import apiClient from '@/lib/api-client';

type VerificationStatus = {
    email: string;
    universityId: string | null;
    eligibility: { eligible: boolean; reason?: string };
    notices: { verification: { version: string; text: string } };
};

function VerificationForm() {
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
    function loadStatus() {
        return apiClient.get<{ data: VerificationStatus }>('/verification/status').then(async (response) => {
            setStatus(response.data.data);
            if (response.data.data.universityId) {
                const available = await apiClient.get(`/verification/methods/${response.data.data.universityId}`).catch(() => null);
                setMethods(available?.data.data.methods ?? []);
            }
        });
    }
    useEffect(() => { void loadStatus().catch(() => setError('Unable to load verification. Please reload this page.')); }, []);
    async function run(operation: () => Promise<void>) {
        setBusy(true); setError(''); setMessage('');
        try { await operation(); }
        catch (cause) {
            setError(axios.isAxiosError(cause) ? cause.response?.data?.error?.message ?? 'Verification is unavailable. Please try again.' : 'Verification is unavailable. Please try again.');
        } finally { setBusy(false); }
    }
    async function processingGrant() {
        if (grant) return grant;
        if (!status?.universityId || !accepted) throw new Error('Consent required');
        const response = await apiClient.post('/verification/initiate', {
            universityId: status.universityId, accepted: true, noticeVersion: status.notices.verification.version,
        });
        const id: string = response.data.data.processingGrantId;
        setGrant(id); return id;
    }
    const emailAvailable = methods?.some((method) => method.methodType === 'email' && method.isAvailable) === true;
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
                const response = await apiClient.post('/verification/email/request', { processingGrantId });
                setChallenge(response.data.data.challengeId); setOtp('');
                setRetryAt(Date.parse(response.data.data.resendAvailableAt));
                setMessage('Check your school email for a six-digit code.');
            })}>{busy ? 'Please wait…' : challenge ? 'Send another code' : 'Send verification code'}</button>
            {methods !== null && !emailAvailable && <p>School email verification is currently unavailable. Please contact support.</p>}
            {challenge && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
                await apiClient.post('/verification/email/confirm', { challengeId: challenge, otp });
                setMailboxConfirmed(true); setChallenge(''); setOtp(''); await loadStatus(); setMessage('School email confirmed.');
            }); }}>
                <label className="block">Email code<input className="block rounded border p-2" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
                <button disabled={busy || otp.length !== 6} className="underline">Confirm email</button>
            </form>}
            {registrationAvailable && mailboxConfirmed ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
                const processingGrantId = await processingGrant();
                const response = await apiClient.post('/verification/registration', { processingGrantId, registrationNumber: registration });
                await loadStatus();
                setMessage(response.data.data.eligibility.eligible ? 'Enrollment confirmed.' : 'Enrollment could not be confirmed. Check your registration number or contact support.');
            }); }}>
                <h2 className="font-semibold">Enrollment check</h2>
                <label className="block">Registration number<input className="block rounded border p-2" value={registration} maxLength={100} required onChange={(event) => setRegistration(event.target.value)} /></label>
                <button disabled={busy || !accepted || !registration.trim()} className="underline">Check enrollment</button>
            </form> : <p>{registrationAvailable ? 'Confirm your school email above before checking enrollment.' : 'Enrollment verification is not currently available for your school.'}</p>}
        </>}
    </main>;
}

export default function StudentVerificationPage() {
    return <ProtectedRoute requiredRole="student"><VerificationForm /></ProtectedRoute>;
}
