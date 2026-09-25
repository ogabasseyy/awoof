'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import apiClient, { publicApiClient } from '@/lib/api-client';
import { useAuth } from '@/contexts/AuthContext';
import { getSessionSnapshot, isCurrentSession } from '@/lib/auth';

type Props = { vendorId: string; origin: string; campaignId: string; purpose: string; state: string };
type Account = ReturnType<typeof useAuth>;
type Merchant = { vendorId: string; origin: string; merchantName: string };
type Status = { eligibility: { eligible: boolean; reason?: string }; notices: { merchantDisclosure: { version: string; text: string } } };
const message = (cause: unknown) => axios.isAxiosError(cause)
    ? (cause.response?.data?.error?.message ?? 'Awoof could not complete this check. Please try again.')
    : 'Awoof could not complete this check. Please try again.';

export default function HostedPilot(props: Props) {
    const auth = useAuth();
    return <PilotSession key={auth.user?.id ?? 'signed-out'} {...props} user={auth.user} isLoading={auth.isLoading} />;
}

function PilotSession(props: Props & Pick<Account, 'user' | 'isLoading'>) {
    const { user, isLoading } = props;
    const [merchant, setMerchant] = useState<Merchant | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const [accepted, setAccepted] = useState(false);
    const [grantId, setGrantId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [loading, setLoading] = useState(true);
    const load = useCallback(async () => {
        setLoading(true); setError('');
        try {
            const context = await publicApiClient.post<{ data: Merchant }>('/widget/merchant-context', { vendorId: props.vendorId, origin: props.origin });
            if (context.data.data.vendorId !== props.vendorId || context.data.data.origin !== props.origin) throw new Error('Merchant mismatch');
            setMerchant(context.data.data);
            if (user?.role === 'student') {
                const current = await apiClient.get<{ data: Status }>('/verification/status');
                setStatus(current.data.data);
            }
        } catch (cause) { setError(message(cause)); setMerchant(null); setStatus(null); }
        finally { setLoading(false); }
    }, [props.vendorId, props.origin, user]);
    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => { if (!cancelled) void load(); });
        return () => { cancelled = true; };
    }, [load]);

    const issue = async () => {
        if (!merchant || !status?.eligibility.eligible || !accepted || busy) return;
        if (!window.opener || window.top !== window.self) { setError('Open this check from the merchant site to continue.'); return; }
        const session = getSessionSnapshot();
        setBusy(true); setError('');
        try {
            let currentGrant = grantId;
            if (!currentGrant) {
                const consent = await apiClient.post<{ data: { grantId: string } }>('/verification/disclosures', {
                    vendorId: props.vendorId, origin: merchant.origin, purpose: props.purpose,
                    accepted: true, noticeVersion: status.notices.merchantDisclosure.version,
                });
                if (!isCurrentSession(session)) throw new Error('Session changed');
                currentGrant = consent.data.data.grantId;
                setGrantId(currentGrant);
            }
            const assertion = await apiClient.post<{ data: { code: string; expiresAt: string } }>('/merchant-verification/pilot-assertions', {
                vendorId: props.vendorId, origin: merchant.origin, purpose: props.purpose,
                campaignId: props.campaignId, disclosureGrantId: currentGrant,
            });
            if (!isCurrentSession(session)) throw new Error('Session changed');
            const { code, expiresAt } = assertion.data.data;
            const expiry = Date.parse(expiresAt);
            if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Invalid assertion response');
            window.opener.postMessage({ type: 'AWOOF_ELIGIBILITY_CODE', state: props.state, campaignId: props.campaignId, code, expiresAt }, merchant.origin);
            setSent(true);
            window.close();
        } catch (cause) { setError(message(cause)); }
        finally { setBusy(false); }
    };

    const loginReturn = `/widget/verify?${new URLSearchParams({
        vendorId: props.vendorId, origin: props.origin, campaignId: props.campaignId,
        purpose: props.purpose, state: props.state,
    }).toString()}`;
    return <main className="mx-auto max-w-lg p-6 sm:p-8" aria-labelledby="pilot-title">
        <h1 id="pilot-title" className="text-2xl font-semibold">Student eligibility check</h1>
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Controlled synthetic-account pilot. This page does not apply a discount or take a payment.</p>
        {loading || isLoading ? <p className="mt-5">Loading merchant and eligibility…</p> : <>
            {merchant && <section aria-label="Merchant request" className="mt-6 space-y-2 rounded-xl border p-4">
                <h2 className="font-semibold">Request from {merchant.merchantName}</h2>
                <p className="break-all text-sm">Site: {merchant.origin}</p>
                <p className="text-sm">Purpose: {props.purpose}</p>
                <p className="text-sm">Campaign: {props.campaignId}</p>
            </section>}
            {!user && merchant && <p className="mt-5">Sign in to your Awoof student account to continue. <Link className="underline" href={`/auth/student/login?redirect=${encodeURIComponent(loginReturn)}`}>Student sign in</Link></p>}
            {user && user.role !== 'student' && <p className="mt-5">Sign in with a student account to continue.</p>}
            {user?.role === 'student' && merchant && status && <section className="mt-6 space-y-4" aria-label="Eligibility and consent">
                <p>{status.eligibility.eligible ? 'Awoof currently has eligible evidence for this account. The server checks it again when issuing and exchanging the code.' : 'Current eligibility is unavailable for this account. Account sign-in or school-email control alone does not establish current enrollment.'}</p>
                {!status.eligibility.eligible && <p><Link className="underline" href="/student/verification" target="_blank" rel="noopener noreferrer">Review your verification status</Link> and then <button className="underline" type="button" onClick={() => void load()}>check again</button>.</p>}
                {status.eligibility.eligible && <>
                    <p className="text-sm">{status.notices.merchantDisclosure.text} The merchant server receives a scoped eligibility receipt, method, institution and expiry after exchanging the code. It does not receive your Awoof account ID, school email or documents in this response.</p>
                    <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={busy || sent} /><span>I approve sharing my current eligibility with {merchant.merchantName} for the purpose shown above.</span></label>
                    <button className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50" type="button" disabled={!accepted || busy || sent} onClick={() => void issue()}>{busy ? 'Checking…' : 'Continue to merchant'}</button>
                </>}
            </section>}
        </>}
        {error && <p role="alert" className="mt-5 text-red-700">{error}</p>}
        {sent && <p role="status" className="mt-5">The code was returned to the merchant. You may close this window.</p>}
        <p className="mt-6 text-sm"><Link className="underline" href="/trust" target="_blank" rel="noopener noreferrer">Security and trust</Link> · <Link className="underline" href="/privacy" target="_blank" rel="noopener noreferrer">Privacy</Link> · <Link className="underline" href="/help" target="_blank" rel="noopener noreferrer">Help</Link></p>
    </main>;
}
