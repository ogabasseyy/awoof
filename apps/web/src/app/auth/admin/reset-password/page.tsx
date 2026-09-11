/**
 * Admin Reset Password Page (OTP Verification)
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

const resetPasswordSchema = z.object({
    email: z.string().email('Invalid email address'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

function maskEmail(email: string): string {
    if (!email || !email.includes('@')) return email;
    const [localPart, domain] = email.split('@');
    if (localPart.length <= 2) {
        return `${localPart[0]}***@${domain}`;
    }
    const visibleChars = Math.min(2, Math.floor(localPart.length / 3));
    const masked = localPart.substring(0, visibleChars) + '***' + localPart.substring(localPart.length - 1);
    return `${masked}@${domain}`;
}

function AdminResetPasswordContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [step, setStep] = useState<'verify' | 'reset'>('verify');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [verifiedOTP, setVerifiedOTP] = useState<string>('');

    const {
        setValue,
        formState: { errors },
    } = useForm<ResetPasswordFormData>({
        resolver: zodResolver(resetPasswordSchema),
        defaultValues: {
            email: '',
        },
    });

    useEffect(() => {
        const emailFromQuery = searchParams.get('email');
        if (emailFromQuery) {
            const decodedEmail = decodeURIComponent(emailFromQuery);
            setEmail(decodedEmail);
            setValue('email', decodedEmail, { shouldValidate: true });
        }
    }, [searchParams, setValue]);

    const verifyOTP = async (data: { email: string; otp: string }) => {
        try {
            setIsLoading(true);
            setError(null);
            const emailToUse = email || data.email;

            if (!emailToUse) {
                setError('Email is required');
                setIsLoading(false);
                return;
            }

            if (!data.otp || data.otp.length !== 6) {
                setError('Please enter a valid 6-digit OTP');
                setIsLoading(false);
                return;
            }

            await apiClient.post('/auth/verify-reset-otp', {
                email: emailToUse,
                otp: data.otp,
            });
            setEmail(emailToUse);
            setVerifiedOTP(data.otp);
            setStep('reset');
        } catch (err: unknown) {
            console.error('Error in verifyOTP:', err);
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Invalid OTP. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const formData = new FormData(e.currentTarget as HTMLFormElement);
        const otp = formData.get('otp') as string;
        const formEmail = formData.get('email') as string;

        const emailToUse = email || formEmail;

        if (!emailToUse) {
            setError('Email is required');
            return;
        }

        if (!otp || otp.length !== 6) {
            setError('Please enter a valid 6-digit OTP');
            return;
        }

        verifyOTP({ email: emailToUse, otp });
    };

    const resetPassword = async (data: ResetPasswordFormData) => {
        try {
            setIsLoading(true);
            setError(null);

            const emailToUse = email || data.email;
            const otpToUse = verifiedOTP || data.otp;

            if (!emailToUse || !otpToUse) {
                setError('Email and OTP are required');
                setIsLoading(false);
                return;
            }

            await apiClient.post('/auth/reset-password', {
                email: emailToUse,
                otp: otpToUse,
                newPassword: data.password,
            });
            router.push('/auth/admin/login?reset=success');
        } catch (err: unknown) {
            console.error('Error in resetPassword:', err);
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to reset password. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleResetFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const formData = new FormData(e.currentTarget as HTMLFormElement);
        const password = formData.get('password') as string;
        const confirmPassword = formData.get('confirmPassword') as string;

        if (!password || password.length < 8) {
            setError('Password must be at least 8 characters');
            return;
        }

        if (password !== confirmPassword) {
            setError("Passwords don't match");
            return;
        }

        resetPassword({
            email: email || '',
            otp: verifiedOTP || '',
            password,
            confirmPassword,
        });
    };

    if (step === 'verify') {
        return (
            <AuthShell
                role="admin"
                title="Verify OTP"
                subtitle={
                    email
                        ? `Enter the 6-digit OTP sent to ${maskEmail(email)}.`
                        : 'Enter the 6-digit OTP sent to your email address.'
                }
            >
                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                        {error}
                    </div>
                )}

                <form onSubmit={handleFormSubmit} className="space-y-5">
                    {email && <input type="hidden" name="email" value={email} />}

                    {!email && (
                        <div>
                            <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                placeholder="you@example.com"
                                aria-invalid={errors.email ? 'true' : 'false'}
                                className="w-full"
                            />
                            {errors.email && (
                                <p className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>
                            )}
                        </div>
                    )}

                    <div>
                        <Label htmlFor="otp" className="text-left block mb-2">OTP</Label>
                        <Input
                            id="otp"
                            name="otp"
                            type="text"
                            placeholder="000000"
                            maxLength={6}
                            aria-invalid={errors.otp ? 'true' : 'false'}
                            className="w-full"
                        />
                        {errors.otp && (
                            <p className="mt-1 text-sm text-red-600 text-left">{errors.otp.message}</p>
                        )}
                    </div>

                    <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                        {isLoading ? 'Verifying...' : 'Verify OTP'}
                    </Button>
                </form>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            role="admin"
            title="Reset Password"
            subtitle="Enter your new password below."
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleResetFormSubmit} className="space-y-5">
                <input type="hidden" name="email" value={email} />
                <input type="hidden" name="otp" value={verifiedOTP} />

                <div>
                    <Label htmlFor="password" className="text-left block mb-2">New Password</Label>
                    <Input
                        id="password"
                        name="password"
                        type="password"
                        placeholder="At least 8 characters"
                        aria-invalid={errors.password ? 'true' : 'false'}
                        className="w-full"
                    />
                    {errors.password && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="confirmPassword" className="text-left block mb-2">Confirm New Password</Label>
                    <Input
                        id="confirmPassword"
                        name="confirmPassword"
                        type="password"
                        placeholder="Re-enter your new password"
                        aria-invalid={errors.confirmPassword ? 'true' : 'false'}
                        className="w-full"
                    />
                    {errors.confirmPassword && (
                        <p className="mt-1 text-sm text-red-600 text-left">{errors.confirmPassword.message}</p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Resetting...' : 'Reset Password'}
                </Button>
            </form>
        </AuthShell>
    );
}

export default function AdminResetPasswordPage() {
    return (
        <Suspense fallback={<AuthShell role="admin" title="Loading..." subtitle="Please wait."><div /></AuthShell>}>
            <AdminResetPasswordContent />
        </Suspense>
    );
}
