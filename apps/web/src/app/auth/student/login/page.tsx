/**
 * Student Login Page
 */

'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { useAuth } from '@/contexts/AuthContext';
import { useStudentAuthLinks } from '@/hooks/useStudentAuthLinks';
import { publicApiClient, studentSsoApiClient } from '@/lib/api-client';
import { getSessionSnapshot } from '@/lib/auth';
import { resolveStudentReturn } from '@/lib/student-return';
import {
    backToEmail,
    choosePassword,
    chooseProvider,
    initialLoginState,
    loginErrorMessage,
    methodsFailed,
    methodsResolved,
    parseLoginErrorCode,
    parseLoginOptions,
    parseSsoStart,
    saveSsoAttempt,
    startFailed,
    submitEmail,
    type LoginState,
    type SsoLoginProvider,
} from '@/lib/student-login-flow';

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const DISCOVERY_UNAVAILABLE = 'School sign-in options are temporarily unavailable. Use your password, or try again.';
const DISCOVERY_RATE_LIMITED = 'Too many school sign-in lookups. Wait a few minutes, or use your password.';
const START_UNAVAILABLE = 'School sign-in could not start. Try again, or use your password.';
const START_STORAGE_BLOCKED = 'This device blocked the school sign-in attempt. Use your password, or allow site storage and try again.';

const PROVIDER_LABELS: Record<SsoLoginProvider, string> = {
    microsoft: 'Continue with Microsoft',
    google: 'Continue with Google',
};

function tabStorage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

function StudentLoginInner() {
    const { login } = useAuth();
    const search = useSearchParams();
    const { registerPath } = useStudentAuthLinks();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [rememberMe, setRememberMe] = useState(false);
    const [flow, setFlow] = useState<LoginState>(initialLoginState);
    const flowRef = useRef(flow);
    const noticeRef = useRef<HTMLDivElement>(null);
    const noticeCode = parseLoginErrorCode(search.get('error'));

    useEffect(() => {
        flowRef.current = flow;
    }, [flow]);

    useEffect(() => {
        const frame = requestAnimationFrame(() => setIsReady(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    useEffect(() => {
        if (noticeCode) noticeRef.current?.focus();
    }, [noticeCode]);

    const {
        register,
        handleSubmit,
        getValues,
        setError: setFieldError,
        formState: { errors },
    } = useForm<LoginFormData>({
        resolver: zodResolver(loginSchema),
    });

    const returnPathFor = (): string => resolveStudentReturn(search.get('redirect'), window.location.origin);

    const discover = async (): Promise<void> => {
        const email = getValues('email').trim();
        if (!z.string().email().safeParse(email).success) {
            setFieldError('email', { type: 'manual', message: 'Enter your email first to find school sign-in options.' });
            document.getElementById('email')?.focus();
            return;
        }
        setError(null);
        const next = submitEmail(flowRef.current, email);
        flowRef.current = next;
        setFlow(next);
        try {
            const response = await publicApiClient.post('/auth/student/login-options', { email: next.email });
            const options = parseLoginOptions(response.data);
            if (!options) {
                setFlow((previous) => methodsFailed(previous, next.requestId, DISCOVERY_UNAVAILABLE));
                return;
            }
            setFlow((previous) => methodsResolved(previous, next.requestId, options.providers));
        } catch (cause: unknown) {
            const status = axios.isAxiosError(cause) ? cause.response?.status : undefined;
            setFlow((previous) => methodsFailed(
                previous,
                next.requestId,
                status === 429 ? DISCOVERY_RATE_LIMITED : DISCOVERY_UNAVAILABLE,
            ));
        }
    };

    const startProvider = async (provider: SsoLoginProvider): Promise<void> => {
        const redirecting = chooseProvider(flowRef.current, provider);
        if (redirecting.step !== 'redirecting') return;
        flowRef.current = redirecting;
        setFlow(redirecting);
        try {
            const response = await studentSsoApiClient.post(`/auth/student/sso/${provider}/start`, {
                email: redirecting.email,
                rememberMe,
                returnPath: returnPathFor(),
            });
            const started = response.status === 201 ? parseSsoStart(response.data) : null;
            if (!started) {
                setFlow((previous) => startFailed(previous, START_UNAVAILABLE));
                return;
            }
            const saved = saveSsoAttempt(tabStorage(), {
                attemptId: started.attemptId,
                finishSecret: started.finishSecret,
                expiresAt: started.expiresAt,
                generation: getSessionSnapshot().generation,
                returnPath: returnPathFor(),
            });
            if (!saved) {
                setFlow((previous) => startFailed(previous, START_STORAGE_BLOCKED));
                return;
            }
            window.location.href = started.authorizationUrl;
        } catch (cause: unknown) {
            const status = axios.isAxiosError(cause) ? cause.response?.status : undefined;
            setFlow((previous) => startFailed(
                previous,
                status === 429 ? DISCOVERY_RATE_LIMITED : START_UNAVAILABLE,
            ));
        }
    };

    const useDifferentEmail = (): void => {
        setFlow((previous) => backToEmail(previous));
        document.getElementById('email')?.focus();
    };

    const usePassword = (): void => {
        setFlow((previous) => choosePassword(previous));
        requestAnimationFrame(() => document.getElementById('password')?.focus());
    };

    const onSubmit = async (data: LoginFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await login(data.email, data.password, 'student', rememberMe);
            // Redirect handled by AuthContext
        } catch (err: unknown) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Login failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AuthShell
            role="student"
            title="Welcome back"
            subtitle="Enter your email to find the right way to sign in."
            footer={
                <p className="text-center text-sm text-slate-600">
                    Don&apos;t have an account?{' '}
                    <Link href={registerPath} className="text-[#1D4ED8] hover:underline font-semibold">
                        Sign up free
                    </Link>
                    <span className="mx-2 text-slate-300">·</span>
                    <Link href="/auth/vendor/login" className="text-slate-500 hover:text-[#1D4ED8] hover:underline">
                        Vendor login
                    </Link>
                </p>
            }
        >
            {noticeCode && (
                <div
                    id="student-login-notice"
                    ref={noticeRef}
                    role="alert"
                    tabIndex={-1}
                    className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400"
                >
                    {loginErrorMessage(noticeCode)}
                </div>
            )}
            {error && (
                <div id="student-login-form-error" role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form
                onSubmit={flow.step === 'password'
                    ? handleSubmit(onSubmit)
                    : (event) => { event.preventDefault(); if (flow.step === 'email' || flow.step === 'error') void discover(); }}
                className="space-y-5"
            >
                <div>
                    <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        autoComplete="username"
                        placeholder="Enter your email"
                        {...register('email')}
                        disabled={!isReady || isLoading}
                        readOnly={flow.step === 'methods' || flow.step === 'password' || flow.step === 'redirecting'}
                        aria-invalid={errors.email ? 'true' : 'false'}
                        aria-describedby={errors.email ? 'student-login-email-error' : undefined}
                        className="w-full"
                    />
                    {errors.email && (
                        <p id="student-login-email-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                    )}
                </div>

                {flow.step === 'password' && <div>
                    <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                    <PasswordInput
                        id="password"
                        autoComplete="current-password"
                        placeholder="Enter your Awoof password"
                        {...register('password')}
                        disabled={!isReady || isLoading}
                        aria-invalid={errors.password ? 'true' : 'false'}
                        aria-describedby={errors.password ? 'student-login-password-error' : undefined}
                        className="w-full"
                    />
                    {errors.password && (
                        <p id="student-login-password-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>
                    )}
                </div>}

                {(flow.step === 'password' || flow.step === 'methods') && <div className="flex items-center justify-between">
                    <label className="flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="mr-2 w-4 h-4"
                            checked={rememberMe}
                            onChange={(event) => setRememberMe(event.target.checked)}
                            disabled={!isReady || isLoading}
                        />
                        <span className="text-sm text-gray-700">Remember me</span>
                    </label>
                    {flow.step === 'password' && <Link
                        href="/auth/student/forgot-password"
                        className="text-sm text-primary hover:underline"
                    >
                        Forgot password?
                    </Link>}
                </div>}

                {(flow.step === 'email' || flow.step === 'error') && <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={!isReady || isLoading}>
                    {flow.step === 'error' ? 'Try again' : 'Continue'}
                </Button>}
                {flow.step === 'loading_methods' && (
                    <p role="status" className="text-left text-sm text-slate-600">Checking sign-in options…</p>
                )}
                {flow.step === 'methods' && (
                    <div className="space-y-3">
                        <p className="text-left text-sm text-slate-600">Choose how to sign in with this email.</p>
                        {flow.error && (
                            <p role="alert" className="text-left text-sm text-red-600">{flow.error}</p>
                        )}
                        {flow.providers.map((provider) => (
                            <Button
                                key={provider}
                                type="button"
                                variant="outline"
                                className="w-full rounded-full h-11 font-semibold"
                                onClick={() => void startProvider(provider)}
                                disabled={!isReady || isLoading}
                            >
                                {PROVIDER_LABELS[provider]}
                            </Button>
                        ))}
                        <button type="button" className="w-full text-sm text-[#1D4ED8] hover:underline font-medium" onClick={usePassword}>
                            Use password instead
                        </button>
                    </div>
                )}
                {flow.step === 'password' && <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={!isReady || isLoading}>
                    {isLoading ? 'Signing in...' : 'Login'}
                </Button>}
                {flow.step === 'error' && flow.error && <p role="alert" className="text-left text-sm text-red-600">{flow.error}</p>}
                {flow.step === 'error' && <button type="button" className="w-full text-sm text-[#1D4ED8] hover:underline font-medium" onClick={usePassword}>
                    Use password instead
                </button>}
                {(flow.step === 'methods' || flow.step === 'password') && <button type="button" className="w-full text-sm text-[#1D4ED8] hover:underline font-medium" onClick={useDifferentEmail}>
                    Use a different email
                </button>}
                {flow.step === 'redirecting' && (
                    <div className="mt-3 space-y-2">
                        <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" disabled>
                            Redirecting to your school sign-in…
                        </Button>
                        <p role="status" className="text-left text-sm text-slate-600">Redirecting to your school sign-in…</p>
                    </div>
                )}
            </form>
        </AuthShell>
    );
}

export default function StudentLoginPage() {
    return (
        <Suspense fallback={<p role="status">Loading student login...</p>}>
            <StudentLoginInner />
        </Suspense>
    );
}
