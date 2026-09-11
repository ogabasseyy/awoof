/**
 * Student Forgot Password Page
 */

'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient from '@/lib/api-client';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';

const forgotPasswordSchema = z.object({
    email: z.string().email('Invalid email address'),
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

export default function StudentForgotPasswordPage() {
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [email, setEmail] = useState<string>('');

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<ForgotPasswordFormData>({
        resolver: zodResolver(forgotPasswordSchema),
    });

    const onSubmit = async (data: ForgotPasswordFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await apiClient.post('/auth/forgot-password', { email: data.email, role: 'student' });
            setEmail(data.email);
            setSuccess(true);
        } catch (err: unknown) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to send OTP. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    if (success) {
        return (
            <AuthShell
                role="student"
                title="Check Your Email"
                subtitle="We've sent a password reset OTP to your email address."
            >
                <Link href={`/auth/student/reset-password?email=${encodeURIComponent(email)}`}>
                    <Button className="w-full rounded-full h-11 font-semibold">Enter OTP</Button>
                </Link>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            role="student"
            title="Forgot Password"
            subtitle="Enter your email address and we'll send you an OTP to reset your password."
            footer={
                <p className="text-center text-sm text-slate-600">
                    Remember your password?{' '}
                    <Link href="/auth/student/login" className="text-primary hover:underline font-medium">
                        Sign in
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
                    <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        {...register('email')}
                        aria-invalid={errors.email ? 'true' : 'false'}
                        className="w-full"
                    />
                    {errors.email && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Sending...' : 'Send OTP'}
                </Button>
            </form>
        </AuthShell>
    );
}
