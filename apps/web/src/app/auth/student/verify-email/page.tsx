/**
 * Student Email Verification Page
 */

'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient from '@/lib/api-client';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';

const verifyEmailSchema = z.object({
    email: z.string().email('Invalid email address'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
});

type VerifyEmailFormData = z.infer<typeof verifyEmailSchema>;

function StudentVerifyEmailContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const emailFromQuery = searchParams.get('email') || '';

    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);

    const {
        register,
        handleSubmit,
        setValue,
        formState: { errors },
    } = useForm<VerifyEmailFormData>({
        resolver: zodResolver(verifyEmailSchema),
        defaultValues: {
            email: emailFromQuery,
        },
    });

    useEffect(() => {
        if (emailFromQuery) {
            setValue('email', emailFromQuery);
        }
    }, [emailFromQuery, setValue]);

    const verifyEmail = async (data: VerifyEmailFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await apiClient.post('/auth/verify-email', {
                email: data.email,
                otp: data.otp,
            });
            router.push('/marketplace?verified=true');
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            setError(err.response?.data?.error?.message || 'Invalid OTP. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const resendOTP = async () => {
        const email = emailFromQuery || (document.querySelector('input[name="email"]') as HTMLInputElement)?.value;
        if (!email) {
            setError('Email is required');
            return;
        }

        try {
            setIsResending(true);
            setError(null);
            setResendSuccess(false);
            await apiClient.post('/auth/resend-email-verification', { email });
            setResendSuccess(true);
            setTimeout(() => setResendSuccess(false), 5000);
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            setError(err.response?.data?.error?.message || 'Failed to resend verification code. Please try again.');
        } finally {
            setIsResending(false);
        }
    };

    return (
        <AuthShell
            role="student"
            title="Verify Your Email"
            subtitle="We've sent a 6-digit verification code to your email address. Please enter it below to verify your account."
            footer={
                <p className="text-center text-sm text-slate-600">
                    Already have an account?{' '}
                    <Link href="/auth/student/login" className="text-primary hover:underline font-medium">
                        Login
                    </Link>
                </p>
            }
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            {resendSuccess && (
                <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm">
                    Verification code sent successfully! Please check your email.
                </div>
            )}

            <form onSubmit={handleSubmit(verifyEmail)} className="space-y-5">
                <div>
                    <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        {...register('email')}
                        aria-invalid={errors.email ? 'true' : 'false'}
                        className="w-full"
                        disabled={!!emailFromQuery}
                    />
                    {errors.email && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="otp" className="text-left block mb-2">Verification Code</Label>
                    <Input
                        id="otp"
                        type="text"
                        placeholder="000000"
                        maxLength={6}
                        {...register('otp')}
                        aria-invalid={errors.otp ? 'true' : 'false'}
                        className="w-full"
                    />
                    {errors.otp && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.otp.message}</p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Verifying...' : 'Verify Email'}
                </Button>

                <div className="text-center">
                    <button
                        type="button"
                        onClick={resendOTP}
                        disabled={isResending}
                        className="text-sm text-primary hover:underline font-medium"
                    >
                        {isResending ? 'Sending...' : "Didn't receive the code? Resend"}
                    </button>
                </div>
            </form>
        </AuthShell>
    );
}

export default function StudentVerifyEmailPage() {
    return (
        <Suspense fallback={<AuthShell role="student" title="Loading..." subtitle="Please wait."><div /></AuthShell>}>
            <StudentVerifyEmailContent />
        </Suspense>
    );
}
