/**
 * Vendor Register Page (Multi-step)
 *
 * Uses context so step components have stable identity and don't remount when
 * only error/isLoading changes — this keeps the selected files visible in Step 3
 * when the upload fails and we show "Logo image is required" (or other errors).
 */

'use client';

import React, { createContext, useContext, useMemo } from 'react';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { type StepConfig } from '@/components/forms/MultiStepForm';
import { useMultiStepForm } from '@/hooks/useMultiStepForm';
import { useVendorRegistration } from './hooks/useVendorRegistration';
import { Step1CompanyInfo } from './components/Step1CompanyInfo';
import { Step2BusinessDetails } from './components/Step2BusinessDetails';
import { Step3DocumentUpload } from './components/Step3DocumentUpload';

type RegistrationContextValue = ReturnType<typeof useVendorRegistration> & ReturnType<typeof useMultiStepForm>;

const VendorRegisterContext = createContext<RegistrationContextValue | null>(null);

function useRegistrationContext() {
    const ctx = useContext(VendorRegisterContext);
    if (!ctx) throw new Error('VendorRegisterPage context missing');
    return ctx;
}

const STEP_SUBTITLES: Record<number, string> = {
    1: 'Tell us about your company.',
    2: 'Add your business details and password.',
    3: 'Upload verification documents and brand assets.',
};

function VendorRegisterProgress({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
    return (
        <div className="flex items-center justify-center">
            <div className="flex items-center">
                {Array.from({ length: totalSteps }, (_, i) => i + 1).map((stepNum) => (
                    <React.Fragment key={stepNum}>
                        <div
                            className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${stepNum <= currentStep
                                ? 'bg-primary text-white'
                                : 'bg-gray-300 text-gray-600'
                                }`}
                        >
                            {stepNum}
                        </div>
                        {stepNum < totalSteps && (
                            <div
                                className={`w-16 h-0.5 mx-2 ${stepNum < currentStep ? 'bg-primary' : 'bg-gray-300'
                                    }`}
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

function Step1Wrapper({ progressIndicator }: { progressIndicator?: React.ReactNode }) {
    const { saveStep1Data, nextStep, error, isLoading } = useRegistrationContext();
    return (
        <Step1CompanyInfo
            onNext={(data) => {
                saveStep1Data(data);
                nextStep();
            }}
            error={error}
            isLoading={isLoading}
            progressIndicator={progressIndicator}
        />
    );
}

function Step2Wrapper({ progressIndicator }: { progressIndicator?: React.ReactNode }) {
    const { previousStep, saveStep2Data, nextStep, error, isLoading } = useRegistrationContext();
    return (
        <Step2BusinessDetails
            onNext={(data) => {
                saveStep2Data(data);
                nextStep();
            }}
            onPrevious={previousStep}
            error={error}
            isLoading={isLoading}
            progressIndicator={progressIndicator}
        />
    );
}

function Step3Wrapper({ progressIndicator }: { progressIndicator?: React.ReactNode }) {
    const {
        previousStep,
        saveFiles,
        submitRegistration,
        clearError,
        registrationData,
        error,
        isLoading,
    } = useRegistrationContext();
    return (
        <Step3DocumentUpload
            onNext={() => {}}
            onPrevious={previousStep}
            onSubmit={async () => {
                clearError();
                await submitRegistration();
            }}
            onFilesChange={saveFiles}
            existingFiles={registrationData.files}
            error={error}
            isLoading={isLoading}
            progressIndicator={progressIndicator}
        />
    );
}

const STEPS: StepConfig[] = [
    { id: 1, component: Step1Wrapper },
    { id: 2, component: Step2Wrapper },
    { id: 3, component: Step3Wrapper },
];

export default function VendorRegisterPage() {
    const form = useMultiStepForm({
        initialStep: 1,
        totalSteps: 3,
    });
    const registration = useVendorRegistration();
    const contextValue = useMemo<RegistrationContextValue>(
        () => ({ ...registration, ...form }),
        [registration, form]
    );

    const currentStepConfig = STEPS.find((step) => step.id === form.currentStep);
    const CurrentStepComponent = currentStepConfig?.component;

    return (
        <VendorRegisterContext.Provider value={contextValue}>
            <AuthShell
                role="vendor"
                title="Create vendor account"
                subtitle={STEP_SUBTITLES[form.currentStep] ?? 'Please fill in your information below.'}
                maxWidthClass="max-w-lg"
                footer={
                    <p className="text-center text-sm text-slate-600">
                        Already have an account?{' '}
                        <Link href="/auth/vendor/login" className="text-primary hover:underline font-medium">
                            Login
                        </Link>
                    </p>
                }
            >
                {CurrentStepComponent ? (
                    <CurrentStepComponent
                        progressIndicator={
                            <VendorRegisterProgress
                                currentStep={form.currentStep}
                                totalSteps={STEPS.length}
                            />
                        }
                    />
                ) : null}
            </AuthShell>
        </VendorRegisterContext.Provider>
    );
}
