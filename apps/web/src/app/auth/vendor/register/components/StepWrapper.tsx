/**
 * Step Wrapper Component
 *
 * Provides consistent layout for each step (progress + error + form only).
 * Page title/subtitle/footer are handled by AuthShell on the register page.
 */

'use client';

import React from 'react';

interface StepWrapperProps {
    children: React.ReactNode;
    error?: string | null;
    progressIndicator?: React.ReactNode;
}

export function StepWrapper({ children, error, progressIndicator }: StepWrapperProps) {
    return (
        <>
            {progressIndicator && <div className="mb-6">{progressIndicator}</div>}

            {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
                    {error}
                </div>
            )}

            {children}
        </>
    );
}
