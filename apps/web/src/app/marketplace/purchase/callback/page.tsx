/**
 * Post-Paystack purchase callback — poll transaction status until terminal.
 */

'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import apiClient from '@/lib/api-client';
import { Button } from '@/components/ui/button';

function PurchaseCallbackContent() {
    const searchParams = useSearchParams();
    const tx = searchParams.get('tx');
    const [status, setStatus] = useState<string>('pending');
    const terminalRef = useRef(false);

    useEffect(() => {
        if (!tx) return;

        let cancelled = false;
        terminalRef.current = false;
        const deadline = Date.now() + 120_000;
        let intervalId: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
            if (terminalRef.current || cancelled) return;
            try {
                const res = await apiClient.get(`/checkout/${tx}`);
                const next = res.data.data?.transaction?.status ?? 'pending';
                if (cancelled) return;
                setStatus(next);
                if (
                    next === 'completed' ||
                    next === 'failed' ||
                    next === 'refunded' ||
                    next === 'requires_refund'
                ) {
                    terminalRef.current = true;
                    if (intervalId) clearTimeout(intervalId);
                }
            } catch {
                // Retry only after this request settles.
            } finally {
                if (!cancelled && !terminalRef.current && Date.now() < deadline) intervalId = setTimeout(poll, 3000);
            }
        };

        // Defer startup so an effect cleanup can cancel it before opening a request.
        intervalId = setTimeout(poll, 0);

        // Safety stop after ~2 minutes
        const timeoutId = setTimeout(() => {
            if (!terminalRef.current) setStatus('timed_out');
            cancelled = true;
            if (intervalId) clearTimeout(intervalId);
        }, 120_000);

        return () => {
            cancelled = true;
            if (intervalId) clearTimeout(intervalId);
            clearTimeout(timeoutId);
        };
    }, [tx]);

    const title =
        status === 'completed'
            ? 'Payment successful'
            : status === 'timed_out'
              ? 'Payment confirmation delayed'
            : status === 'refunded'
              ? 'Payment refunded'
            : status === 'requires_refund'
              ? 'Payment received — refund required'
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
                {status === 'timed_out' && (
                    <div className="space-y-3 text-sm text-slate-600">
                        <p>We could not confirm the outcome yet. Do not pay again. Reload this page to check again, or contact support with your transaction ID.</p>
                        <p>Transaction ID: {tx}</p>
                        <Button onClick={() => window.location.reload()}>Check again</Button>
                    </div>
                )}
                {status === 'completed' && (
                    <Link href="/student/profile/receipts">
                        <Button className="w-full">View receipts</Button>
                    </Link>
                )}
                {status === 'requires_refund' && (
                    <p className="text-sm text-amber-700">
                        Your order could not be completed. Your payment has been
                        flagged for refund; please contact support with your transaction ID.
                    </p>
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
