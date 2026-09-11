/**
 * Step 1: Company Information
 */

'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepWrapper } from './StepWrapper';
import type { Step1Data } from '../hooks/useVendorRegistration';

const step1Schema = z.object({
    companyName: z.string().min(2, 'Company name must be at least 2 characters'),
    companyEmail: z.string().email('Invalid email address'),
    fullName: z.string().min(2, 'Full name must be at least 2 characters'),
    phoneNumber: z.string().min(10, 'Invalid phone number'),
});

interface Step1CompanyInfoProps {
    onNext: (data: Step1Data) => void;
    error?: string | null;
    isLoading?: boolean;
    progressIndicator?: React.ReactNode;
}

export function Step1CompanyInfo({ onNext, error, isLoading, progressIndicator }: Step1CompanyInfoProps) {
    const form = useForm<Step1Data>({
        resolver: zodResolver(step1Schema),
    });

    const onSubmit = (data: Step1Data) => {
        onNext(data);
    };

    return (
        <StepWrapper progressIndicator={progressIndicator} error={error}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                <div>
                    <Label htmlFor="companyName" className="text-left block mb-2">
                        Company&apos;s Name
                    </Label>
                    <Input
                        id="companyName"
                        type="text"
                        placeholder="Enter your company's Name"
                        {...form.register('companyName')}
                        aria-invalid={form.formState.errors.companyName ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.companyName && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.companyName.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="companyEmail" className="text-left block mb-2">
                        Company&apos;s Email
                    </Label>
                    <Input
                        id="companyEmail"
                        type="email"
                        placeholder="Enter your company's Email"
                        {...form.register('companyEmail')}
                        aria-invalid={form.formState.errors.companyEmail ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.companyEmail && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.companyEmail.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="fullName" className="text-left block mb-2">Full Name</Label>
                    <Input
                        id="fullName"
                        type="text"
                        placeholder="Enter your full name"
                        {...form.register('fullName')}
                        aria-invalid={form.formState.errors.fullName ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.fullName && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.fullName.message}
                        </p>
                    )}
                </div>

                <div>
                    <Label htmlFor="phoneNumber" className="text-left block mb-2">Phone Number</Label>
                    <Input
                        id="phoneNumber"
                        type="tel"
                        placeholder="Enter your phone number"
                        {...form.register('phoneNumber')}
                        aria-invalid={form.formState.errors.phoneNumber ? 'true' : 'false'}
                        className="w-full"
                    />
                    {form.formState.errors.phoneNumber && (
                        <p className="mt-1 text-sm text-red-600 text-left">
                            {form.formState.errors.phoneNumber.message}
                        </p>
                    )}
                </div>

                <Button type="submit" className="w-full rounded-full h-11 font-semibold" disabled={isLoading}>
                    Continue
                </Button>
            </form>
        </StepWrapper>
    );
}

