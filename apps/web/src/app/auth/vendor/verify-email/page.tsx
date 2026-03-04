/**
 * Vendor Email Verification Page
 */

'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';

const verifyEmailSchema = z.object({
    email: z.string().email('Invalid email address'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
});

type VerifyEmailFormData = z.infer<typeof verifyEmailSchema>;

function VendorVerifyEmailContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const emailFromQuery = searchParams.get('email') || '';
    const profileError = searchParams.get('profileError') || null;

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

    // Set email from query params
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
            // Redirect to vendor dashboard after successful verification
            router.push('/vendor/dashboard?verified=true');
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
        <div className="min-h-screen flex bg-white">
            <div className="flex-[2] flex items-center justify-center px-8 lg:px-16">
                <div className="w-full max-w-md">
                    <h1 className="text-2xl font-bold mb-2 text-left">Verify Your Email</h1>
                    <p className="text-gray-600 mb-6 text-left">
                        We&apos;ve sent a 6-digit verification code to your email address. Please enter it below to verify your account.
                    </p>

                    {profileError && (
                        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-md text-sm">
                            Your account was created and a verification code was sent to your email. We couldn&apos;t complete your profile: {profileError} You can verify below and complete your profile from the dashboard after logging in.
                        </div>
                    )}

                    {error && (
                        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
                            {error}
                        </div>
                    )}

                    {resendSuccess && (
                        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">
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

                        <Button type="submit" className="w-full" disabled={isLoading}>
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

                        <p className="mt-6 text-center text-sm text-gray-600">
                            Already have an account?{' '}
                            <Link href="/auth/vendor/login" className="text-primary hover:underline font-medium">
                                Login
                            </Link>
                        </p>
                    </form>
                </div>
            </div>
            <div className="hidden lg:block flex-[3] bg-cover bg-center bg-no-repeat min-h-screen" style={{ backgroundImage: 'url(/images/auth.png)' }}>
                <div className="h-full flex items-center justify-end p-8">
                    <div className="text-black text-right">
                        <h2 className="text-3xl font-bold mb-4">Awoof</h2>
                        <p className="text-lg">Connect with students</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function VendorVerifyEmailPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-white">Loading...</div>}>
            <VendorVerifyEmailContent />
        </Suspense>
    );
}

