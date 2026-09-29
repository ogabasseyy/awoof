'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { publicApiClient } from '@/lib/api-client';
import { serverSkewSince } from '@/lib/student-login-flow';

function formatRecoveryRemaining(deadlineMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Lost-response retries must present the original start's idempotency
// key: a cooldown retry only replaces the live attempt when bound, so an
// anonymous caller knowing the email cannot silently fail the victim's
// handle. The binding survives restarts within the tab (a re-submit is a
// retry of the same logical start) and clears on completion.
const RECOVERY_IDEMPOTENCY_KEY = 'awoof.recovery.idempotency.v1.tab';
function readRetryBinding(): { email: string; purpose: string; key: string } | null {
    try {
        const raw = sessionStorage.getItem(RECOVERY_IDEMPOTENCY_KEY); if (!raw) return null;
        const value = JSON.parse(raw) as { email?: unknown; purpose?: unknown; key?: unknown };
        return typeof value.email === 'string' && typeof value.purpose === 'string' && typeof value.key === 'string' && value.key.length > 0 ? { email: value.email, purpose: value.purpose, key: value.key } : null;
    } catch { return null; }
}
function retryBindingFor(email: string, purpose: string): string {
    const normalized = email.trim().toLowerCase();
    const stored = readRetryBinding();
    if (stored && stored.email === normalized && stored.purpose === purpose) return stored.key;
    const key = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `retry-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
    try { sessionStorage.setItem(RECOVERY_IDEMPOTENCY_KEY, JSON.stringify({ email: normalized, purpose, key })); } catch { /* a lost binding only forfeits rebound, never blocks start */ }
    return key;
}
function clearRetryBinding(): void { try { sessionStorage.removeItem(RECOVERY_IDEMPOTENCY_KEY); } catch { /* nothing persisted */ } }

export default function StudentAccountRecoveryPage() {
    const [email, setEmail] = useState(''); const [compromise, setCompromise] = useState(false); const [sent, setSent] = useState(false); const [error, setError] = useState<string | null>(null); const [attempt, setAttempt] = useState<{ id: string; secret: string; expiresAt: string; otpExpiresAt: string; skewMs: number } | null>(null); const [recoveryCode, setRecoveryCode] = useState(''); const [otp, setOtp] = useState(''); const [verified, setVerified] = useState(false); const [password, setPassword] = useState(''); const [completeSuccess, setCompleteSuccess] = useState(false); const [starting, setStarting] = useState(false); const [completeFailed, setCompleteFailed] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [completing, setCompleting] = useState(false);
    const completionInFlight = useRef(false);
    useEffect(() => {
        if (!attempt) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [attempt]);
    // Proof verification must occur within the shorter OTP deadline
    // while password completion may use the remaining attempt window:
    // each deadline is displayed and enforced in the UI instead of
    // failing delayed forms with a generic restart message. The skew
    // sampled from the start response keeps a fast device clock from
    // expiring a live attempt early.
    const deadlineMs = attempt ? Date.parse(attempt.expiresAt) : NaN;
    const otpDeadlineMs = attempt ? Date.parse(attempt.otpExpiresAt) : NaN;
    const correctedNow = now + (attempt?.skewMs ?? 0);
    const activeDeadlineMs = verified ? deadlineMs : otpDeadlineMs;
    const expired = attempt !== null && !Number.isNaN(activeDeadlineMs) && activeDeadlineMs <= correctedNow;
    const restart = () => { setAttempt(null); setSent(false); setVerified(false); setPassword(''); setRecoveryCode(''); setOtp(''); setError(null); setCompleteFailed(false); };
    const start = async (event: React.FormEvent) => { event.preventDefault(); if (starting) return; setStarting(true); setError(null); try { const purpose = compromise ? 'compromise' : 'lost_access'; const r = await publicApiClient.post('/auth/student/sso/account-recovery/start', { email, purpose, idempotencyKey: retryBindingFor(email, purpose) }); const data = (r.data as { data?: { attemptId?: unknown; secret?: unknown; expiresAt?: unknown; otpExpiresAt?: unknown; serverNow?: unknown } }).data; if (typeof data?.attemptId !== 'string' || typeof data.secret !== 'string' || typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))) throw new Error('invalid'); const otpExpiresAt = typeof data.otpExpiresAt === 'string' && !Number.isNaN(Date.parse(data.otpExpiresAt)) ? data.otpExpiresAt : data.expiresAt; setAttempt({ id: data.attemptId, secret: data.secret, expiresAt: data.expiresAt, otpExpiresAt, skewMs: serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null) }); setSent(true); } catch { setError('Recovery could not be started. Check the details and try again.'); } finally { setStarting(false); } };
    const verify = async (event: React.FormEvent) => {
        event.preventDefault(); if (!attempt) return; setError(null);
        try {
            const response = await publicApiClient.post('/auth/student/sso/account-recovery/verify', { attemptId: attempt.id, secret: attempt.secret, code: recoveryCode, otp });
            const data = (response.data as { data?: { expiresAt?: unknown; serverNow?: unknown } }).data;
            if (typeof data?.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))) throw new Error('invalid completion deadline');
            setAttempt({ ...attempt, expiresAt: data.expiresAt, skewMs: serverSkewSince(typeof data.serverNow === 'string' && !Number.isNaN(Date.parse(data.serverNow)) ? data.serverNow : null) });
            setRecoveryCode(''); setOtp(''); setVerified(true);
        } catch { setError('Recovery proof could not be confirmed. Start again if the attempt expired.'); }
    };
    const complete = async (event: React.FormEvent) => {
        event.preventDefault(); if (!attempt || completionInFlight.current) return;
        completionInFlight.current = true;
        setCompleting(true); setError(null); setCompleteFailed(false);
        try {
            await publicApiClient.post('/auth/student/sso/account-recovery/complete', { attemptId: attempt.id, secret: attempt.secret, password });
            clearRetryBinding();
            setAttempt(null); setPassword(''); setVerified(false); setSent(false); setCompleteSuccess(true);
        } catch (cause: unknown) {
            // Password-policy conflicts are deterministic and save nothing.
            // Other 409s may mean an earlier completion committed but its
            // response was lost, so retain the sign-in recovery guidance.
            const response = axios.isAxiosError(cause) ? cause.response : undefined;
            const message = (response?.data as { error?: { message?: unknown } } | undefined)?.error?.message;
            const isPasswordPolicyRejection = response?.status === 409
                && typeof message === 'string'
                && message.startsWith('Password must ');
            if (response && response.status < 500 && (response.status !== 409 || isPasswordPolicyRejection)) {
                setError(typeof message === 'string' && message ? message : 'Password setup was rejected. Check the requirements and try again.');
            } else {
                setCompleteFailed(true);
                setError('Password setup did not confirm. The password may already be set: try signing in with it before starting recovery again.');
            }
        } finally {
            completionInFlight.current = false;
            setCompleting(false);
        }
    };
    return <AuthShell role="student" title="Account recovery" subtitle="Use this only if you cannot use school sign-in." footer={null}>
        {completeSuccess ? <div className="space-y-4 text-left"><p role="status" className="text-green-700">Password set. Sign in with your password to continue.</p><Button className="w-full rounded-full" asChild><a href="/auth/student/login">Sign in with password</a></Button></div> : expired ? <div className="space-y-4 text-left"><p role="alert">This recovery attempt expired before completion. Start again for a fresh attempt.</p><Button className="w-full rounded-full" onClick={restart}>Start again</Button></div> : verified ? <form onSubmit={complete} className="space-y-3 text-left"><p className="text-sm">Set the required password for this recovery, then sign in normally. This recovery does not grant enrollment eligibility.</p>{Number.isNaN(deadlineMs) ? null : <p role="timer" className="text-sm text-slate-600">Complete this recovery within {formatRecoveryRemaining(deadlineMs, correctedNow)}.</p>}<label htmlFor="recovery-password">New password<input id="recovery-password" type="password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label><p className="text-sm text-slate-600">Use at least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character.</p>{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}{completeFailed ? <Button type="button" variant="outline" className="w-full rounded-full" asChild><a href="/auth/student/login">Try signing in with this password</a></Button> : null}<Button type="submit" disabled={completing} className="w-full rounded-full">{completing ? 'Setting password…' : 'Set password'}</Button></form> : sent ? <form onSubmit={verify} className="space-y-3 text-left"><p role="status" className="text-sm">If this account can use recovery, enter both the saved recovery code and the email confirmation code. Sign in with your password afterward.</p>{Number.isNaN(otpDeadlineMs) ? null : <p role="timer" className="text-sm text-slate-600">Confirm both codes within {formatRecoveryRemaining(otpDeadlineMs, correctedNow)}.</p>}<label htmlFor="saved-code">Saved recovery code<input id="saved-code" value={recoveryCode} onChange={e => setRecoveryCode(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label><label htmlFor="mailbox-otp">Email confirmation code<input id="mailbox-otp" value={otp} onChange={e => setOtp(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label>{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}<Button type="submit" className="w-full rounded-full">Confirm recovery proofs</Button><Button type="button" variant="outline" onClick={() => { setAttempt(null); setSent(false); setRecoveryCode(''); setOtp(''); }} className="w-full rounded-full">Cancel and restart</Button></form> : <form onSubmit={start} className="space-y-4 text-left"><p className="text-sm text-slate-600">Recovery requires your school mailbox and saved recovery code. Mailbox access alone never transfers account ownership. If you no longer have both, recovery cannot continue — read <Link className="text-primary underline" href="/help">how account recovery works</Link> for what each proof is for.</p><label className="block text-sm font-medium" htmlFor="recovery-email">School email<input id="recovery-email" aria-label="School email" type="email" required value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full rounded-2xl border px-4 h-11" /></label><label className="flex gap-2 text-sm"><input aria-label="I think my sign-in was compromised" type="checkbox" checked={compromise} onChange={e => setCompromise(e.target.checked)} />I think my sign-in was compromised</label>{compromise ? <p role="alert" className="text-sm text-amber-700">Completing this recovery will disconnect all linked external sign-in identities. Secure your Microsoft account and mailbox too; Awoof cannot revoke their sessions.</p> : <p className="text-sm text-slate-600">Lost-access recovery keeps linked school sign-ins connected when they remain available.</p>}{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}<Button type="submit" disabled={starting} className="w-full rounded-full">Start recovery</Button></form>}
    </AuthShell>;
}
