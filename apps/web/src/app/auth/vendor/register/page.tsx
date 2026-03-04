/**
 * Vendor Register Page (Multi-step)
 *
 * Uses context so step components have stable identity and don't remount when
 * only error/isLoading changes — this keeps the selected files visible in Step 3
 * when the upload fails and we show "Logo image is required" (or other errors).
 */

'use client';

import React, { createContext, useContext, useMemo } from 'react';
import { MultiStepForm, type StepConfig } from '@/components/forms/MultiStepForm';
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

// Stable step components (defined outside page so they don't remount when error state changes)
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

    return (
        <VendorRegisterContext.Provider value={contextValue}>
            <MultiStepForm
                steps={STEPS}
                currentStep={form.currentStep}
                onStepChange={form.goToStep}
                showProgress={true}
            />
        </VendorRegisterContext.Provider>
    );
}
