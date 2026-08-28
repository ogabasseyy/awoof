/**
 * Login Page
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

export default function LoginPage() {
    const router = useRouter();
    const { login } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

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
            await login(data.email, data.password);
            router.push('/');
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            setError(err.response?.data?.error?.message || 'Login failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AuthShell
            role="generic"
            title="Sign In"
            subtitle="Sign in to your Awoof account."
            footer={
                <p className="text-center text-sm text-slate-600">
                    Don&apos;t have an account?{' '}
                    <Link href="/auth/register" className="text-primary hover:underline font-medium">
                        Sign up
                    </Link>
                </p>
            }
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div>
                    <Label htmlFor="email">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        {...register('email')}
                        aria-invalid={errors.email ? 'true' : 'false'}
                    />
                    {errors.email && (
                        <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="password">Password</Label>
                    <Input
                        id="password"
                        type="password"
                        placeholder="Enter your password"
                        {...register('password')}
                        aria-invalid={errors.password ? 'true' : 'false'}
                    />
                    {errors.password && (
                        <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <Link
                        href="/auth/forgot-password"
                        className="text-sm text-primary hover:underline"
                    >
                        Forgot password?
                    </Link>
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Signing in...' : 'Sign In'}
                </Button>
            </form>
        </AuthShell>
    );
}
