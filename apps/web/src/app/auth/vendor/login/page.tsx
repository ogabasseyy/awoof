/**
 * Vendor Login Page
 */

'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function VendorLoginPage() {
    const { login } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
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
            await login(data.email, data.password, 'vendor', rememberMe);
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
            role="vendor"
            title="Welcome back"
            subtitle="Log in to manage deals, orders, and payouts."
            footer={
                <p className="text-center text-sm text-slate-600">
                    Don&apos;t have an account?{' '}
                    <Link href="/auth/vendor/register" className="text-primary hover:underline font-medium">
                        Sign Up
                    </Link>
                </p>
            }
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                <div>
                    <Label htmlFor="email" className="text-left block mb-2">Company&apos;s Email</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder="Enter your company's Email"
                        {...register('email')}
                        aria-invalid={errors.email ? 'true' : 'false'}
                        className="w-full"
                    />
                    {errors.email && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                    <div className="relative">
                        <Input
                            id="password"
                            type={showPassword ? 'text' : 'password'}
                            placeholder="Enter your password"
                            {...register('password')}
                            aria-invalid={errors.password ? 'true' : 'false'}
                            className="w-full pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                        >
                            {showPassword ? (
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                </svg>
                            ) : (
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                            )}
                        </button>
                    </div>
                    {errors.password && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <label className="flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="mr-2 w-4 h-4"
                            checked={rememberMe}
                            onChange={(e) => setRememberMe(e.target.checked)}
                        />
                        <span className="text-sm text-gray-700">Remember me</span>
                    </label>
                    <Link
                        href="/auth/vendor/forgot-password"
                        className="text-sm text-primary hover:underline"
                    >
                        Forgot Password?
                    </Link>
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Logging in...' : 'Login'}
                </Button>
            </form>
        </AuthShell>
    );
}
