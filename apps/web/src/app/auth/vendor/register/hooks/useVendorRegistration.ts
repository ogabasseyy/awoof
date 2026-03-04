/**
 * Custom Hook for Vendor Registration Business Logic
 * 
 * Single Responsibility: Only handles vendor registration business logic
 */

import { useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import apiClient from '@/lib/api-client';

export interface Step1Data {
    companyName: string;
    companyEmail: string;
    fullName: string;
    phoneNumber: string;
}

export interface Step2Data {
    businessCategory: string;
    businessWebsite?: string;
    password: string;
    confirmPassword: string;
}

export interface VendorRegistrationData {
    step1: Step1Data | null;
    step2: Step2Data | null;
    files: {
        documentFront?: File;
        documentBack?: File;
        logoImage?: File;
        bannerImage?: File;
    };
}

export function useVendorRegistration() {
    const { register: registerUser } = useAuth();
    const [registrationData, setRegistrationData] = useState<VendorRegistrationData>({
        step1: null,
        step2: null,
        files: {},
    });
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    /** True after register + complete-registration succeeded; on retry we only re-run the upload step. */
    const [registrationPhaseDone, setRegistrationPhaseDone] = useState(false);

    const saveStep1Data = (data: Step1Data) => {
        setRegistrationData((prev) => ({
            ...prev,
            step1: data,
        }));
    };

    const saveStep2Data = (data: Step2Data) => {
        setRegistrationData((prev) => ({
            ...prev,
            step2: data,
        }));
    };

    const saveFiles = useCallback((files: { documentFront?: File | null; documentBack?: File | null; logoImage?: File | null; bannerImage?: File | null }) => {
        setRegistrationData((prev) => {
            // Merge new files with existing files - only update fields that are provided
            // This prevents clearing other files when one is selected
            // undefined = don't update, null/undefined = clear (remove), File = set
            const mergedFiles = {
                ...prev.files,
            };

            // Update only the fields that are explicitly provided
            if (files.documentFront !== undefined) {
                mergedFiles.documentFront = files.documentFront || undefined;
            }
            if (files.documentBack !== undefined) {
                mergedFiles.documentBack = files.documentBack || undefined;
            }
            if (files.logoImage !== undefined) {
                mergedFiles.logoImage = files.logoImage || undefined;
            }
            if (files.bannerImage !== undefined) {
                mergedFiles.bannerImage = files.bannerImage || undefined;
            }

            // Check if anything actually changed
            const filesChanged =
                prev.files.documentFront !== mergedFiles.documentFront ||
                prev.files.documentBack !== mergedFiles.documentBack ||
                prev.files.logoImage !== mergedFiles.logoImage ||
                prev.files.bannerImage !== mergedFiles.bannerImage;

            if (!filesChanged) {
                return prev;
            }

            return { ...prev, files: mergedFiles };
        });
    }, []);

    const submitRegistration = async () => {
        if (!registrationData.step1 || !registrationData.step2) {
            throw new Error('Missing registration data');
        }

        try {
            setIsLoading(true);
            setError(null);

            if (!registrationPhaseDone) {
                // Step 1: Register user account (sends verification email)
                await registerUser(
                    registrationData.step1.companyEmail,
                    registrationData.step2.password,
                    registrationData.step1.fullName,
                    'vendor'
                );
            }

            let completeOrUploadFailed = false;
            let stepError: string | null = null;

            try {
                if (!registrationPhaseDone) {
                    // Step 2: Complete vendor registration with company details
                    await apiClient.post('/vendors/complete-registration', {
                        companyName: registrationData.step1.companyName,
                        phoneNumber: registrationData.step1.phoneNumber,
                        businessCategory: registrationData.step2.businessCategory,
                        businessWebsite: registrationData.step2.businessWebsite || '',
                    });
                    setRegistrationPhaseDone(true);
                }

                // Step 3: Upload files - logo is required
                if (!registrationData.files.logoImage) {
                    throw new Error('Logo image is required');
                }

                const filesToUpload = Object.entries(registrationData.files).filter(([, file]) => file !== undefined);
                if (filesToUpload.length > 0) {
                    const formData = new FormData();
                    filesToUpload.forEach(([fieldName, file]) => {
                        if (file) {
                            formData.append(fieldName, file);
                        }
                    });

                    await apiClient.post('/vendors/upload', formData, {
                        headers: {
                            'Content-Type': 'multipart/form-data',
                        },
                    });
                }
            } catch (stepErr: unknown) {
                completeOrUploadFailed = true;
                const e = stepErr as {
                    response?: { data?: { error?: { message?: string }; message?: string } };
                    message?: string;
                };
                stepError =
                    e.response?.data?.error?.message ||
                    e.response?.data?.message ||
                    e.message ||
                    'Profile or file upload failed.';
                setError(stepError);
            }

            // If logo was missing, do not redirect – keep user on Step 3 to upload logo
            const isLogoRequiredError =
                stepError &&
                (stepError === 'Logo image is required' ||
                    stepError.toLowerCase().includes('logo image is required') ||
                    stepError.toLowerCase().includes('logo is required'));
            if (completeOrUploadFailed && isLogoRequiredError) {
                throw new Error(stepError ?? 'Logo image is required');
            }

            // Redirect to verify-email once account is created (user already received the email)
            if (typeof window !== 'undefined') {
                const params = new URLSearchParams({ email: registrationData.step1.companyEmail });
                if (completeOrUploadFailed && stepError) {
                    params.set('profileError', stepError);
                }
                window.location.href = `/auth/vendor/verify-email?${params.toString()}`;
            }
        } catch (err: unknown) {
            // Reach here if registerUser() failed OR we rethrew after upload/logo error (to stay on form)
            const error = err as {
                response?: { data?: { error?: { message?: string }; message?: string } };
                message?: string;
            };
            const errorMessage =
                error.response?.data?.error?.message ||
                error.response?.data?.message ||
                error.message ||
                'Failed to create account. Please try again.';
            setError(errorMessage);
            throw new Error(errorMessage);
        } finally {
            setIsLoading(false);
        }
    };

    const clearError = () => {
        setError(null);
    };

    return {
        registrationData,
        error,
        isLoading,
        saveStep1Data,
        saveStep2Data,
        saveFiles,
        submitRegistration,
        clearError,
    };
}

