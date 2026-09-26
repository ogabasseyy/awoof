'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { getSessionSnapshot } from '@/lib/auth';
import { studentSsoApiClient } from '@/lib/api-client';

type RecoveryStatus = 'loading' | 'unconfigured' | 'pending' | 'active' | 'unavailable';
const intentKey = 'awoof.recovery.intent.v1.tab';

/** Only opaque server ids and operation names survive a provider redirect. No grant, code, or password is persisted. */
function saveIntent(intent: { purpose: 'recovery_code_generate' | 'recovery_code_activate'; pendingCodeId?: string }): boolean {
    try { sessionStorage.setItem(intentKey, JSON.stringify(intent)); return true; } catch { return false; }
}
function pendingIntent(): string | null { try { const value = JSON.parse(sessionStorage.getItem(intentKey) ?? '') as { purpose?: unknown; pendingCodeId?: unknown }; return value.purpose === 'recovery_code_activate' && typeof value.pendingCodeId === 'string' ? value.pendingCodeId : null; } catch { return null; } }

export default function StudentSecurityPage() {
    const [status, setStatus] = useState<RecoveryStatus>('loading'); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false); const started = useRef(false);
    useEffect(() => {
        if (started.current) return; started.current = true;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('unavailable'); return; }
        void studentSsoApiClient.get('/auth/student/sso/recovery-code', { headers: { Authorization: `Bearer ${session.accessToken}` } })
            .then(r => { const data = (r.data as { data?: { status?: unknown; pendingCodeId?: unknown } }).data; const value = data?.status; setPendingCodeId(typeof data?.pendingCodeId === 'string' ? data.pendingCodeId : null); setStatus(value === 'active' || value === 'pending' || value === 'unconfigured' ? value : 'unavailable'); })
            .catch(() => setStatus('unavailable'));
    }, []);
    const begin = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken) { setStatus('unavailable'); return; }
        setBusy(true);
        try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_generate' }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const beginRemove = async () => {
        if (busy) return; const session = getSessionSnapshot(); if (!session.accessToken || !saveIntent({ purpose: 'recovery_code_generate' })) { setStatus('unavailable'); return; }
        setBusy(true); try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_remove' }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error(); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const beginActivation = async () => {
        const pendingId = pendingCodeId ?? pendingIntent(); const session = getSessionSnapshot(); if (!pendingId || !session.accessToken || busy) { setStatus('unavailable'); return; }
        setBusy(true); try { const r = await studentSsoApiClient.post('/auth/student/sso/reauth/microsoft/start', { purpose: 'recovery_code_activate', pendingCodeId: pendingId }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const url = (r.data as { data?: { authorizationUrl?: unknown } }).data?.authorizationUrl; if (typeof url !== 'string' || !url.startsWith('https:')) throw new Error('invalid'); window.location.assign(url); } catch { setBusy(false); setStatus('unavailable'); }
    };
    const cancelPending = async () => {
        const session = getSessionSnapshot(); if (!pendingCodeId || !session.accessToken || busy) return;
        setBusy(true); try { await studentSsoApiClient.post('/auth/student/sso/recovery-code/cancel', { pendingCodeId }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); setPendingCodeId(null); setStatus('unconfigured'); } catch { setStatus('unavailable'); } finally { setBusy(false); }
    };
    if (status === 'unavailable') return <AuthShell role="student" title="Account security" subtitle="Security setup is unavailable." footer={null}><p role="status">Sign in again and retry. If school sign-in is unavailable, use recovery only if you already saved a recovery code.</p><Link className="mt-5 inline-block text-primary underline" href="/auth/student/recovery">Account recovery</Link></AuthShell>;
    return <AuthShell role="student" title="Account security" subtitle="Optional recovery-code setup." footer={null}>
        <p className="text-left text-sm text-slate-600">Confirm your identity, save your code, then confirm your identity again to activate it. The code is shown once and is never stored in this browser, emailed, or placed in a URL. Recovery also needs access to your school mailbox; it does not promise permanent access.</p>
        {status === 'active' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A recovery code is active. Replacing or removing it requires the current code and fresh confirmation.</p><Button type="button" onClick={begin} disabled={busy} className="w-full rounded-full">Replace recovery code</Button><Button type="button" variant="outline" onClick={beginRemove} disabled={busy} className="w-full rounded-full">Remove recovery code</Button></div> : status === 'pending' ? <div className="mt-4 space-y-3"><p role="status" className="text-left text-sm">A pending code exists but cannot recover your account. Confirm your identity again before it expires.</p><Button type="button" onClick={beginActivation} disabled={busy || !pendingCodeId} className="w-full rounded-full">Confirm identity to activate saved code</Button><Button type="button" variant="outline" onClick={cancelPending} disabled={busy || !pendingCodeId} className="w-full rounded-full">Cancel pending code</Button></div> : <Button type="button" onClick={begin} disabled={busy || status === 'loading'} className="mt-5 w-full rounded-full">{busy ? 'Redirecting…' : 'Confirm identity to generate a code'}</Button>}
    </AuthShell>;
}
