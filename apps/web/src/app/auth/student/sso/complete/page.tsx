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
    parseSsoReauthFinish,
    readSsoAttempt,
    saveSsoHandoff,
    ssoAttemptMatches,
    ssoFailureLoginPath,
    ssoPostLoginDestination,
    type LoginErrorCode,
    type SsoAttemptRecord,
} from '@/lib/student-login-flow';

type RecoveryIntent = { purpose: 'recovery_code_generate' | 'recovery_code_activate'; pendingCodeId?: string };
const RECOVERY_INTENT_KEY = 'awoof.recovery.intent.v1.tab';
function readRecoveryIntent(): RecoveryIntent | null {
    try {
        const raw = sessionStorage.getItem(RECOVERY_INTENT_KEY); if (!raw) return null;
        const value = JSON.parse(raw) as Partial<RecoveryIntent>;
        return (value.purpose === 'recovery_code_generate' || value.purpose === 'recovery_code_activate')
            && (value.pendingCodeId === undefined || typeof value.pendingCodeId === 'string') ? value as RecoveryIntent : null;
    } catch { return null; }
}
function clearRecoveryIntent(): void { try { sessionStorage.removeItem(RECOVERY_INTENT_KEY); } catch { /* no browser persistence available */ } }

function RecoveryReauthComplete({ attemptId }: { attemptId: string }) {
    const [status, setStatus] = useState<'checking' | 'generate' | 'display' | 'activate' | 'remove' | 'failed' | 'active'>('checking');
    const [code, setCode] = useState(''); const [pendingCodeId, setPendingCodeId] = useState<string | null>(null); const [grant, setGrant] = useState<{ grantId: string; grantSecret: string } | null>(null); const [error, setError] = useState<string | null>(null);
    const started = useRef(false);
    useEffect(() => {
        if (started.current) return; started.current = true;
        const session = getSessionSnapshot();
        if (!session.accessToken) { setStatus('failed'); return; }
        void studentSsoApiClient.post('/auth/student/sso/reauth/finish', { attemptId }, { headers: { Authorization: `Bearer ${session.accessToken}` } }).then(async response => {
            const grant = parseSsoReauthFinish(response.data); if (!grant) throw new Error('invalid grant');
            if (grant.purpose === 'recovery_code_generate') {
                clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
                if (grant.activeCodeGeneration !== null) { setStatus('generate'); return; }
                const generated = await studentSsoApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: { grantId: grant.grantId, grantSecret: grant.grantSecret } }, { headers: { Authorization: `Bearer ${session.accessToken}` } });
                const data = (generated.data as { data?: { pendingCodeId?: unknown; code?: unknown } }).data;
                if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error('invalid code');
                setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code); setStatus('display'); return;
            }
            if (grant.purpose === 'recovery_code_remove') { clearRecoveryIntent(); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret }); setStatus('remove'); return; }
            if (grant.purpose !== 'recovery_code_activate' || !grant.pendingCodeId) throw new Error('missing pending');
            clearRecoveryIntent();
            // The user re-enters the value here after the second fresh proof; it was never persisted through the redirect.
            setPendingCodeId(grant.pendingCodeId); setGrant({ grantId: grant.grantId, grantSecret: grant.grantSecret });
            setStatus('activate');
        }).catch(() => { clearRecoveryIntent(); setStatus('failed'); });
    }, [attemptId]);
    const activate = async () => {
        const session = getSessionSnapshot(); if (!grant || !pendingCodeId || !session.accessToken || !code) { setStatus('failed'); return; }
        try { await studentSsoApiClient.post('/auth/student/sso/recovery-code/activate', { reauthGrant: grant, pendingCodeId, code }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); setGrant(null); setCode(''); setStatus('active'); }
        catch { setError('This confirmation could not be completed. If the pending code expired, restart setup.'); }
    };
    const generateReplacement = async () => {
        const session = getSessionSnapshot(); if (!grant || !session.accessToken || !code) return;
        try { const r = await studentSsoApiClient.post('/auth/student/sso/recovery-code/generate', { reauthGrant: grant, oldCode: code }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); const data = (r.data as { data?: { pendingCodeId?: unknown; code?: unknown } }).data; if (!data || typeof data.pendingCodeId !== 'string' || typeof data.code !== 'string') throw new Error(); setGrant(null); setPendingCodeId(data.pendingCodeId); setCode(data.code); setStatus('display'); } catch { setError('The current recovery code could not be confirmed.'); }
    };
    const remove = async () => { const session = getSessionSnapshot(); if (!grant || !session.accessToken || !code) return; try { await studentSsoApiClient.post('/auth/student/sso/recovery-code/remove', { reauthGrant: grant, oldCode: code }, { headers: { Authorization: `Bearer ${session.accessToken}` } }); setGrant(null); setCode(''); setStatus('active'); } catch { setError('The current recovery code could not be confirmed.'); } };
    if (status === 'generate') return <AuthShell role="student" title="Replace recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="old-recovery-code">Current recovery code<input id="old-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button className="mt-5 w-full rounded-full" onClick={generateReplacement}>Generate replacement code</Button></AuthShell>;
    if (status === 'display') return <AuthShell role="student" title="Save your recovery code" subtitle="It will not be shown again." footer={null}><p role="alert" className="rounded-xl bg-amber-50 p-3 break-all font-mono text-left">{code}</p><p className="mt-3 text-left text-sm">Save this code somewhere secure. It is not stored in this browser, sent by email, or added to a URL. Then return to Account security and confirm your identity again to activate it.</p><Button className="mt-5 w-full rounded-full" onClick={() => { if (pendingCodeId) try { sessionStorage.setItem(RECOVERY_INTENT_KEY, JSON.stringify({ purpose: 'recovery_code_activate', pendingCodeId })); } catch { /* security page reports unavailable */ } setCode(''); window.location.href = '/student/security'; }}>I saved my code</Button></AuthShell>;
    if (status === 'activate') return <AuthShell role="student" title="Confirm your recovery code" subtitle="Fresh identity confirmation completed." footer={null}><label className="block text-left text-sm" htmlFor="recovery-code-confirm">Re-enter saved recovery code<input id="recovery-code-confirm" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}<Button className="mt-5 w-full rounded-full" onClick={activate}>Activate recovery code</Button></AuthShell>;
    if (status === 'remove') return <AuthShell role="student" title="Remove recovery code" subtitle="Confirm your current code." footer={null}><label htmlFor="remove-recovery-code">Current recovery code<input id="remove-recovery-code" value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert">{error}</p> : null}<Button className="mt-5 w-full rounded-full" onClick={remove}>Remove recovery code</Button></AuthShell>;
    if (status === 'active') return <AuthShell role="student" title="Recovery code active" subtitle="Your optional recovery setup is complete." footer={null}><p role="status">Keep your saved code secure. It is required with your school mailbox for independent password recovery.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/marketplace">Continue</Link></Button></AuthShell>;
    return <AuthShell role="student" title="Security confirmation unavailable" subtitle="The fresh confirmation expired or was interrupted." footer={null}><p role="status">No recovery code was activated. Start the optional setup again.</p><Button className="mt-5 w-full rounded-full" asChild><Link href="/student/security">Back to account security</Link></Button></AuthShell>;
}

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

    const reauthAttempt = search.get('reauth');
    if (reauthAttempt) return <RecoveryReauthComplete attemptId={reauthAttempt} />;

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
                    // The server refuses to overwrite a session that appeared
                    // while this attempt was in flight: surface the surviving
                    // concurrent sign-in instead of expiring to the login page.
                    const latest = getSessionSnapshot();
                    if (latest.accessToken || latest.refreshToken) {
                        clearSsoAttempt(storage);
                        if (latest.generation === record.generation) {
                            setView({
                                kind: 'already_signed_in',
                                continuePath: resolveStudentReturn(record.returnPath, window.location.origin),
                            });
                        } else {
                            setView({ kind: 'discarded' });
                        }
                        return;
                    }
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
                // The attempt is cleared below, so the handoff carries the
                // validated return path forward for post-link continuation.
                const kept = saveSsoHandoff(storage, {
                    handoffId: finished.handoffId,
                    handoffSecret: finished.handoffSecret,
                    expiresAt: finished.expiresAt,
                    returnPath: record.returnPath,
                    serverSkewMs: record.serverSkewMs,
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
                        <Link href="/auth/student/sso/onboarding?mode=signup">Create a passwordless account</Link>
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
