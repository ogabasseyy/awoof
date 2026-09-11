/**
 * Register Page
 */

'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { useStudentAuthLinks } from '@/hooks/useStudentAuthLinks';

function AccountOptions() {
    const { registerPath } = useStudentAuthLinks();

    return (
        <div className="grid gap-4">
            <Link
                href={registerPath}
                className="rounded-xl border p-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                Continue as a student
            </Link>
            <Link
                href="/auth/vendor/register"
                className="rounded-xl border p-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                Continue as a vendor
            </Link>
        </div>
    );
}

export default function RegisterPage() {
    return (
        <AuthShell
            role="generic"
            title="Create Account"
            subtitle="Join Awoof as a student or vendor."
            maxWidthClass="max-w-lg"
            footer={
                <p className="text-center text-sm text-slate-600">
                    Already have an account?{' '}
                    <Link href="/auth/login" className="text-primary hover:underline font-medium">
                        Sign in
                    </Link>
                </p>
            }
        >
            <Suspense fallback={<p role="status">Loading account options...</p>}>
                <AccountOptions />
            </Suspense>
        </AuthShell>
    );
}
