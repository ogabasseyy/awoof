'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    clearTokens,
    getSessionSnapshot,
    isCurrentSession,
    subscribeSessionChanges,
    type SessionSnapshot,
} from '@/lib/auth';
import { passwordProofApiClient, refreshSessionAccessToken } from '@/lib/api-client';

type CapturedSession = { snapshot: SessionSnapshot; userId: string };

/**
 * Danger zone for self-service student account closure. The backend
 * soft-deletes the account (`users.deleted_at`), revokes every session,
 * and the academic profile is purged after the retention window. The
 * client only collects the confirmation the server requires: the
 * current password for password accounts, or the exact phrase
 * CLOSE MY ACCOUNT for passwordless accounts.
 *
 * The destructive action is bound to the session and account that
 * opened the form: any session change resets it, and tokens are only
 * cleared when that captured session is still the current one.
 */
export default function AccountClosureSection({ userId }: { userId: string }) {
    const [open, setOpen] = useState(false);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const capturedRef = useRef<CapturedSession | null>(null);

    const resetForm = () => {
        capturedRef.current = null;
        setOpen(false);
        setPassword('');
        setConfirmation('');
        setError(null);
        setBusy(false);
    };

    useEffect(() => subscribeSessionChanges(() => {
        const captured = capturedRef.current;
        if (captured && !isCurrentSession(captured.snapshot)) resetForm();
    }), []);

    const openForm = () => {
        capturedRef.current = { snapshot: getSessionSnapshot(), userId };
        setError(null);
        setOpen(true);
    };

    const submit = async () => {
        const captured = capturedRef.current;
        if (!captured || captured.userId !== userId || !isCurrentSession(captured.snapshot)) {
            resetForm();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // Fresh access token for the proof request; the DELETE itself
            // stays on the non-refreshing client so a wrong password is an
            // inline error, never a session-clearing 401 retry.
            await refreshSessionAccessToken().catch(() => undefined);
            if (!isCurrentSession(captured.snapshot)) { resetForm(); return; }
            await passwordProofApiClient.delete('/students/account', {
                data: {
                    ...(password ? { password } : {}),
                    ...(confirmation ? { confirmation } : {}),
                },
            });
            if (isCurrentSession(captured.snapshot)) {
                clearTokens();
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign('/auth/student/login');
            } else {
                resetForm();
            }
        } catch {
            if (isCurrentSession(captured.snapshot)) {
                setError('Account closure failed. Check your password (or type CLOSE MY ACCOUNT exactly) and try again.');
                setBusy(false);
            } else {
                resetForm();
            }
        }
    };

    return (
        <div className="mt-8 border-t pt-5 text-left">
            <h2 className="text-base font-semibold text-red-700">Close account</h2>
            <p className="mt-1 text-sm text-slate-600">
                Closing your account signs you out everywhere and stops sign-in immediately. Your optional
                academic profile is deleted from live systems after 30 days; backup copies expire on the
                schedule described in the privacy notice. Contact support within 30 days if you closed your
                account by mistake.
            </p>
            {open ? (
                <div className="mt-3 space-y-3">
                    <label className="block text-sm" htmlFor="closure-password">
                        Current password (password accounts)
                        <input
                            id="closure-password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className="mt-1 w-full rounded-2xl border px-4 h-11"
                        />
                    </label>
                    <label className="block text-sm" htmlFor="closure-confirmation">
                        Passwordless accounts: type CLOSE MY ACCOUNT
                        <input
                            id="closure-confirmation"
                            value={confirmation}
                            onChange={(event) => setConfirmation(event.target.value)}
                            className="mt-1 w-full rounded-2xl border px-4 h-11"
                        />
                    </label>
                    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
                    <Button type="button" variant="destructive" onClick={() => void submit()} disabled={busy || (!password && confirmation !== 'CLOSE MY ACCOUNT')} className="w-full rounded-full">
                        {busy ? 'Closing…' : 'Permanently close my account'}
                    </Button>
                    <Button type="button" variant="ghost" onClick={resetForm} disabled={busy} className="w-full rounded-full">
                        Keep my account
                    </Button>
                </div>
            ) : (
                <Button type="button" variant="outline" onClick={openForm} className="mt-3 w-full rounded-full">
                    Close my account
                </Button>
            )}
        </div>
    );
}
