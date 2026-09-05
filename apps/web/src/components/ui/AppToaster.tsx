'use client';

import { Toaster } from 'react-hot-toast';

export function AppToaster() {
    return (
        <Toaster
            position="top-right"
            toastOptions={{
                duration: 4000,
                style: {
                    borderRadius: '12px',
                    background: '#0f172a',
                    color: '#f8fafc',
                    fontSize: '14px',
                    padding: '12px 16px',
                    maxWidth: '420px',
                },
                success: {
                    iconTheme: {
                        primary: '#22c55e',
                        secondary: '#0f172a',
                    },
                },
                error: {
                    iconTheme: {
                        primary: '#ef4444',
                        secondary: '#0f172a',
                    },
                },
            }}
        />
    );
}
