/**
 * Reset Password Page (Multi-Step)
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient from '@/lib/api-client';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const verifyOTPSchema = z.object({
    email: z.string().email('Invalid email address'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
});

const resetPasswordSchema = z.object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

type VerifyOTPFormData = z.infer<typeof verifyOTPSchema>;
type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

export default function ResetPasswordPage() {
    const router = useRouter();
    const [step, setStep] = useState<'verify' | 'reset'>('verify');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');

    const verifyForm = useForm<VerifyOTPFormData>({
        resolver: zodResolver(verifyOTPSchema),
    });

    const resetForm = useForm<ResetPasswordFormData>({
        resolver: zodResolver(resetPasswordSchema),
    });

    const { handleSubmit: handleVerifySubmit, formState: { errors: verifyErrors } } = verifyForm;
    const { handleSubmit: handleResetSubmit, formState: { errors: resetErrors } } = resetForm;

    const verifyOTP = async (data: VerifyOTPFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await apiClient.post('/auth/verify-reset-otp', {
                email: data.email,
                otp: data.otp,
            });
            setEmail(data.email);
            setOtp(data.otp);
            setStep('reset');
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            const errorMessage = err.response?.data?.error?.message || 'Invalid OTP or email. Please try again.';
            setError(errorMessage);
        } finally {
            setIsLoading(false);
        }
    };

    const resetPassword = async (data: ResetPasswordFormData) => {
        try {
            setIsLoading(true);
            setError(null);
            await apiClient.post('/auth/reset-password', {
                email,
                otp,
                password: data.password,
            });
            router.push('/auth/login?reset=success');
        } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            setError(err.response?.data?.error?.message || 'Failed to reset password. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    if (step === 'verify') {
        return (
            <AuthShell
                role="generic"
                title="Verify OTP"
                subtitle="Enter the 6-digit OTP sent to your email."
            >
                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                        {error}
                    </div>
                )}

                <form onSubmit={handleVerifySubmit(verifyOTP)} className="space-y-4">
                    <div>
                        <Label htmlFor="email" className="text-left block mb-2">Email</Label>
                        <Input
                            id="email"
                            type="email"
                            placeholder="you@example.com"
                            {...verifyForm.register('email')}
                            aria-invalid={verifyErrors.email ? 'true' : 'false'}
                            className="w-full"
                        />
                        {verifyErrors.email && (
                            <p className="mt-1 text-sm text-red-600 text-left">{verifyErrors.email.message}</p>
                        )}
                    </div>

                    <div>
                        <Label htmlFor="otp" className="text-left block mb-2">OTP</Label>
                        <Input
                            id="otp"
                            type="text"
                            placeholder="000000"
                            maxLength={6}
                            {...verifyForm.register('otp')}
                            aria-invalid={verifyErrors.otp ? 'true' : 'false'}
                            className="w-full"
                        />
                        {verifyErrors.otp && (
                            <p className="mt-1 text-sm text-red-600 text-left">{verifyErrors.otp.message}</p>
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
            role="generic"
            title="Reset Password"
            subtitle="Enter your new password below."
        >
            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleResetSubmit(resetPassword)} className="space-y-4">
                <div>
                    <Label htmlFor="password" className="text-left block mb-2">New Password</Label>
                    <Input
                        id="password"
                        type="password"
                        placeholder="At least 8 characters"
                        {...resetForm.register('password')}
                        aria-invalid={resetErrors.password ? 'true' : 'false'}
                        className="w-full"
                    />
                    {resetErrors.password && (
                        <p className="mt-1 text-sm text-red-600 text-left">{resetErrors.password.message}</p>
                    )}
                </div>

                <div>
                    <Label htmlFor="confirmPassword" className="text-left block mb-2">Confirm Password</Label>
                    <Input
                        id="confirmPassword"
                        type="password"
                        placeholder="Re-enter your password"
                        {...resetForm.register('confirmPassword')}
                        aria-invalid={resetErrors.confirmPassword ? 'true' : 'false'}
                        className="w-full"
                    />
                    {resetErrors.confirmPassword && (
                        <p className="mt-1 text-sm text-red-600 text-left">{resetErrors.confirmPassword.message}</p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    {isLoading ? 'Resetting...' : 'Reset Password'}
                </Button>
            </form>
        </AuthShell>
    );
}
