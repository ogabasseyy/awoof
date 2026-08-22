/**
 * Post-Paystack purchase callback — poll transaction status.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import apiClient from '@/lib/api-client';
import { Button } from '@/components/ui/button';

function PurchaseCallbackContent() {
    const searchParams = useSearchParams();
    const tx = searchParams.get('tx');
    const [status, setStatus] = useState<string>('pending');

    useEffect(() => {
        if (!tx) return;

        const poll = async () => {
            try {
                const res = await apiClient.get(`/checkout/${tx}`);
                setStatus(res.data.data?.transaction?.status ?? 'pending');
            } catch {
                // Keep polling while webhook processes
            }
        };

        poll();
        const intervalId = setInterval(poll, 3000);
        return () => clearInterval(intervalId);
    }, [tx]);

    const title =
        status === 'completed'
            ? 'Payment successful'
            : status === 'failed'
              ? 'Payment failed'
              : 'Processing payment…';

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-sm p-8 max-w-md w-full text-center space-y-4">
                <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
                {status === 'pending' && (
                    <p className="text-sm text-slate-500">
                        This may take a few seconds while we confirm your payment.
                    </p>
                )}
                {status === 'completed' && (
                    <Link href="/student/profile/receipts">
                        <Button className="w-full">View receipts</Button>
                    </Link>
                )}
                <Link href="/marketplace">
                    <Button variant="outline" className="w-full">
                        Back to marketplace
                    </Button>
                </Link>
            </div>
        </div>
    );
}

export default function PurchaseCallbackPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                    <p className="text-slate-500">Loading…</p>
                </div>
            }
        >
            <PurchaseCallbackContent />
        </Suspense>
    );
}
