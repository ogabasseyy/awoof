/**
 * Student Login Page
 */

'use client';

import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { useAuth } from '@/contexts/AuthContext';
import { useStudentAuthLinks } from '@/hooks/useStudentAuthLinks';

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

function StudentLoginInner() {
    const { login } = useAuth();
    const { registerPath } = useStudentAuthLinks();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [rememberMe, setRememberMe] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<LoginFormData>({
        resolver: zodResolver(loginSchema),
    });

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
                        autoComplete="email"
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
