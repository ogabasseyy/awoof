/**
 * Step 2: Business Details
 */

'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Label } from '@/components/ui/label';
import { StepWrapper } from './StepWrapper';
import Link from 'next/link';
import type { Step2Data } from '../hooks/useVendorRegistration';

const step2Schema = z.object({
    businessCategory: z.string().min(1, 'Please select a business category'),
    businessWebsite: z.string().url('Invalid website URL').optional().or(z.literal('')),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
});

interface Step2BusinessDetailsProps {
    onNext: (data: Step2Data) => void;
    onPrevious: () => void;
    error?: string | null;
    isLoading?: boolean;
    progressIndicator?: React.ReactNode;
}

export function Step2BusinessDetails({ onNext, onPrevious, error, isLoading, progressIndicator }: Step2BusinessDetailsProps) {
    const form = useForm<Step2Data>({
        resolver: zodResolver(step2Schema),
    });

    const onSubmit = (data: Step2Data) => {
        onNext(data);
    };

    return (
        <StepWrapper
            title="Create An Account"
            subtitle="Please fill in your information below."
            progressIndicator={progressIndicator}
            error={error}
            footer={
                <p className="mt-6 text-center text-sm text-gray-600">
                    Already have an account?{' '}
                    <Link href="/auth/vendor/login" className="text-primary hover:underline font-medium">
                        Login
                    </Link>
                </p>
            }
        >
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                <div>
                    <Label htmlFor="businessCategory" className="text-left block mb-2">
                        Business Category
                    </Label>
                    <select
                        id="businessCategory"
                        {...form.register('businessCategory')}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        <option value="">Select your business category</option>
                        <option value="fashion">Fashion & Apparel</option>
                        <option value="electronics">Electronics</option>
                        <option value="food">Food & Beverage</option>
                        <option value="education">Education</option>
                        <option value="travel">Travel & Tourism</option>
                        <option value="entertainment">Entertainment</option>
                        <option value="other">Other</option>
                    </select>
                    {form.formState.errors.businessCategory && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.businessCategory.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="businessWebsite" className="text-left block mb-2">
                        Business Website
                    </Label>
                    <Input
                        id="businessWebsite"
                        type="url"
                        placeholder="Enter your website URL"
                        {...form.register('businessWebsite')}
                        aria-invalid={form.formState.errors.businessWebsite ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.businessWebsite && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.businessWebsite.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                    <PasswordInput
                        id="password"
                        placeholder="Enter your Password"
                        {...form.register('password')}
                        aria-invalid={form.formState.errors.password ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.password && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.password.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="confirmPassword" className="text-left block mb-2">
                        Confirm Password
                    </Label>
                    <PasswordInput
                        id="confirmPassword"
                        placeholder="Enter your password again"
                        {...form.register('confirmPassword')}
                        aria-invalid={form.formState.errors.confirmPassword ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.confirmPassword && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.confirmPassword.message}
                        </p>
                    )}
                </div>

                <div className="flex gap-4">
                    <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        onClick={onPrevious}
                        disabled={isLoading}
                    >
                        Back
                    </Button>
                    <Button type="submit" className="flex-1" disabled={isLoading}>
                        {isLoading ? 'Creating...' : 'Continue'}
                    </Button>
                </div>
            </form>
        </StepWrapper>
    );
}

