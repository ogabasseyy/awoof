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
    const [rememberMe, setRememberMe] = useState(false);
    const [flow, setFlow] = useState<LoginState>(initialLoginState);
    const flowRef = useRef(flow);
    const noticeRef = useRef<HTMLDivElement>(null);
    const noticeCode = parseLoginErrorCode(search.get('error'));

    useEffect(() => {
        flowRef.current = flow;
    }, [flow]);

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
            subtitle="Log in to claim deals and manage your student account."
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

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                <div>
                    <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        autoComplete="username"
                        placeholder="Enter your email"
                        {...register('email')}
                        disabled={isLoading}
                        aria-invalid={errors.email ? 'true' : 'false'}
                        aria-describedby={errors.email ? 'student-login-email-error' : undefined}
                        className="w-full"
                    />
                    {errors.email && (
                        <p id="student-login-email-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                    <PasswordInput
                        id="password"
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        {...register('password')}
                        disabled={isLoading}
                        aria-invalid={errors.password ? 'true' : 'false'}
                        aria-describedby={errors.password ? 'student-login-password-error' : undefined}
                        className="w-full"
                    />
                    {errors.password && (
                        <p id="student-login-password-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <label className="flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="mr-2 w-4 h-4"
                            checked={rememberMe}
                            onChange={(event) => setRememberMe(event.target.checked)}
                            disabled={isLoading}
                        />
                        <span className="text-sm text-gray-700">Remember me</span>
                    </label>
                    <Link
                        href="/auth/student/forgot-password"
                        className="text-sm text-primary hover:underline"
                    >
                        Forgot password?
                    </Link>
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Signing in...' : 'Login'}
                </Button>
            </form>

            <section aria-labelledby="student-sso-heading" className="mt-6 border-t border-slate-200 pt-6">
                <h2 id="student-sso-heading" className="text-left text-sm font-semibold text-slate-700">School account sign-in</h2>
                <p className="mt-1 text-left text-sm text-slate-600">
                    Enter your school email above, then find the sign-in options your school approved. Your password always works.
                </p>
                {(flow.step === 'email' || flow.step === 'password' || flow.step === 'error') && (
                    <div className="mt-3 space-y-2">
                        {flow.step === 'password' && (
                            <p role="status" className="text-left text-sm text-slate-600">
                                No school sign-in is available for this email. Use your password to sign in.
                            </p>
                        )}
                        {flow.step === 'error' && flow.error && (
                            <p role="alert" className="text-left text-sm text-red-600">{flow.error}</p>
                        )}
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full rounded-full h-11 font-semibold"
                            onClick={() => void discover()}
                            disabled={isLoading}
                        >
                            Find school sign-in options
                        </Button>
                    </div>
                )}
                {flow.step === 'loading_methods' && (
                    <div className="mt-3 space-y-2">
                        <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" disabled>
                            Checking sign-in options…
                        </Button>
                        <p role="status" className="text-left text-sm text-slate-600">Checking sign-in options…</p>
                    </div>
                )}
                {flow.step === 'methods' && (
                    <div className="mt-3 space-y-2">
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
                                disabled={isLoading}
                            >
                                {PROVIDER_LABELS[provider]}
                            </Button>
                        ))}
                        <p className="text-left text-sm text-slate-600">Your password above still works if you prefer it.</p>
                        <button type="button" className="text-sm text-[#1D4ED8] hover:underline font-medium" onClick={useDifferentEmail}>
                            Use a different email
                        </button>
                    </div>
                )}
                {flow.step === 'redirecting' && (
                    <div className="mt-3 space-y-2">
                        <Button type="button" variant="outline" className="w-full rounded-full h-11 font-semibold" disabled>
                            Redirecting to your school sign-in…
                        </Button>
                        <p role="status" className="text-left text-sm text-slate-600">Redirecting to your school sign-in…</p>
                    </div>
                )}
            </section>
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
