/**
 * Student Register Page
 *
 * Two-step signup: (1) form → register-request, (2) OTP input → register-confirm
 * Redirects to marketplace on success
 */

'use client';

import React, { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Label } from '@/components/ui/label';
import { UniversitySelect } from '@/components/forms/UniversitySelect';
import apiClient from '@/lib/api-client';
import { storeTokens } from '@/lib/auth';
import Link from 'next/link';

const formSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    university: z.string().uuid('Invalid university ID'),
    matricNumber: z.string().optional(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

type FormData = z.infer<typeof formSchema>;

export default function StudentRegisterPage() {
    const [step, setStep] = useState<'form' | 'otp'>('form');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);
    const [emailVerificationStatus, setEmailVerificationStatus] = useState<'idle' | 'verifying' | 'verified' | 'failed'>('idle');
    const [formData, setFormData] = useState<FormData | null>(null);

    const {
        register,
        handleSubmit,
        control,
        watch,
        formState: { errors },
    } = useForm<FormData>({
        resolver: zodResolver(formSchema),
    });

    const email = watch('email');
    const university = watch('university');

    const verifyEmailWithUniversity = async (emailToVerify: string, universityId: string) => {
        if (!emailToVerify || !universityId || !z.string().uuid().safeParse(universityId).success) {
            setEmailVerificationStatus('idle');
            return;
        }
        try {
            setEmailVerificationStatus('verifying');
            setError(null);
            await apiClient.post('/auth/verify-student-email', {
                email: emailToVerify,
                universityId,
            });
            setEmailVerificationStatus('verified');
        } catch {
            setEmailVerificationStatus('failed');
            setError('Email not found in university database');
        }
    };

    useEffect(() => {
        if (email && university && z.string().uuid().safeParse(university).success) {
            const timeoutId = setTimeout(() => verifyEmailWithUniversity(email, university), 1000);
            return () => clearTimeout(timeoutId);
        } else {
            setEmailVerificationStatus('idle');
        }
    }, [email, university]);

    const onSubmitForm = async (data: FormData) => {
        try {
            setIsLoading(true);
            setError(null);

            await apiClient.post('/auth/verify-student-email', {
                email: data.email,
                universityId: data.university,
            });

            await apiClient.post('/auth/student/register-request', {
                email: data.email,
                password: data.password,
                name: data.name,
                universityId: data.university,
                matricNumber: data.matricNumber?.trim() || undefined,
            });

            setFormData(data);
            setStep('otp');
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
            setError(e.response?.data?.error?.message || e.message || 'Registration request failed.');
        } finally {
            setIsLoading(false);
        }
    };

    const onSubmitOtp = async (data: { otp: string }) => {
        if (!formData) return;
        try {
            setIsLoading(true);
            setError(null);

            const res = await apiClient.post('/auth/student/register-confirm', {
                email: formData.email,
                otp: data.otp,
                password: formData.password,
                name: formData.name,
                universityId: formData.university,
                matricNumber: formData.matricNumber?.trim() || undefined,
            });

            const { tokens } = res.data.data;
            storeTokens(tokens);

            const redirectTo = res.data.data.redirectTo || '/marketplace';
            if (typeof window !== 'undefined') {
                window.location.href = redirectTo;
            }
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
            setError(e.response?.data?.error?.message || e.message || 'Invalid or expired OTP.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleBackFromOtp = () => {
        setStep('form');
        setFormData(null);
        setError(null);
        setResendSuccess(false);
    };

    const resendOtp = async () => {
        if (!formData) return;
        try {
            setIsResending(true);
            setError(null);
            setResendSuccess(false);

            await apiClient.post('/auth/student/register-request', {
                email: formData.email,
                password: formData.password,
                name: formData.name,
                universityId: formData.university,
                matricNumber: formData.matricNumber?.trim() || undefined,
            });

            setResendSuccess(true);
            setTimeout(() => setResendSuccess(false), 5000);
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
            setError(e.response?.data?.error?.message || e.message || 'Failed to resend code. Please try again.');
        } finally {
            setIsResending(false);
        }
    };

    return (
        <AuthShell
            role="student"
            title={step === 'form' ? 'Create Student Account' : 'Enter Verification Code'}
            subtitle={
                step === 'form'
                    ? 'Join Awoof and get exclusive student discounts.'
                    : `We sent a 6-digit code to ${formData?.email}. Enter it below.`
            }
            maxWidthClass="max-w-lg"
            footer={
                <p className="text-center text-sm text-slate-600">
                    Already have an account?{' '}
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

            {resendSuccess && step === 'otp' && (
                <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm">
                    A new verification code was sent. Check your email.
                </div>
            )}

            {step === 'form' ? (
                <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5">
                    <div>
                        <Label htmlFor="name" className="text-left block mb-2">Full Name</Label>
                        <Input id="name" type="text" placeholder="John Doe" {...register('name')} className="w-full" aria-invalid={!!errors.name} />
                        {errors.name && <p className="mt-1 text-sm text-red-600 text-left">{errors.name.message}</p>}
                    </div>

                    <div>
                        <Label htmlFor="email" className="text-left block mb-2">Student Email</Label>
                        <Input id="email" type="email" placeholder="you@university.edu.ng" {...register('email')} className="w-full" aria-invalid={!!errors.email} />
                        {errors.email && <p className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>}
                        {emailVerificationStatus === 'verifying' && <p className="mt-1 text-sm text-blue-600 text-left">Verifying email...</p>}
                        {emailVerificationStatus === 'verified' && <p className="mt-1 text-sm text-green-600 text-left">✓ Email verified</p>}
                        {emailVerificationStatus === 'failed' && <p className="mt-1 text-sm text-red-600 text-left">Email not found in university database</p>}
                    </div>

                    <Controller
                        name="university"
                        control={control}
                        render={({ field }) => (
                            <UniversitySelect
                                value={field.value && z.string().uuid().safeParse(field.value).success ? field.value : ''}
                                onChange={(id, uni) => {
                                    field.onChange(id || '');
                                    setEmailVerificationStatus('idle');
                                }}
                                error={errors.university?.message}
                                required
                            />
                        )}
                    />

                    <div>
                        <Label htmlFor="matricNumber" className="text-left block mb-2">
                            Matric Number <span className="text-gray-400 ml-1 text-xs">(Optional)</span>
                        </Label>
                        <Input id="matricNumber" type="text" placeholder="Enter your matric number" {...register('matricNumber')} className="w-full" />
                    </div>

                    <div>
                        <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                        <PasswordInput id="password" placeholder="At least 8 characters" {...register('password')} className="w-full" aria-invalid={!!errors.password} />
                        {errors.password && <p className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>}
                    </div>

                    <div>
                        <Label htmlFor="confirmPassword" className="text-left block mb-2">Confirm Password</Label>
                        <PasswordInput id="confirmPassword" placeholder="Re-enter your password" {...register('confirmPassword')} className="w-full" aria-invalid={!!errors.confirmPassword} />
                        {errors.confirmPassword && <p className="mt-1 text-sm text-red-600 text-left">{errors.confirmPassword.message}</p>}
                    </div>

                    <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                        {isLoading ? 'Sending code...' : 'Continue'}
                    </Button>
                </form>
            ) : (
                <form onSubmit={(e) => { e.preventDefault(); onSubmitOtp({ otp: (e.target as HTMLFormElement).otp.value }); }} className="space-y-5">
                    <div>
                        <Label htmlFor="otp" className="text-left block mb-2">Verification Code</Label>
                        <Input id="otp" name="otp" type="text" placeholder="Enter 6-digit code" maxLength={6} className="w-full text-center text-lg tracking-widest" required />
                    </div>
                    <div className="flex gap-3">
                        <Button type="button" variant="outline" onClick={handleBackFromOtp} className="flex-1 rounded-full h-11 font-semibold">
                            Back
                        </Button>
                        <Button type="submit" className="flex-1 rounded-full h-11 font-semibold" disabled={isLoading}>
                            {isLoading ? 'Verifying...' : 'Create Account'}
                        </Button>
                    </div>
                    <p className="text-center text-sm text-slate-600">
                        Didn&apos;t get the code?{' '}
                        <button
                            type="button"
                            onClick={resendOtp}
                            disabled={isResending || isLoading}
                            className="text-primary hover:underline font-medium disabled:opacity-50 disabled:no-underline"
                        >
                            {isResending ? 'Sending…' : 'Resend code'}
                        </button>
                    </p>
                </form>
            )}
        </AuthShell>
    );
}
