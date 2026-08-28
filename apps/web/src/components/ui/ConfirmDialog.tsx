'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';

export type ConfirmOptions = {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
    const confirm = useContext(ConfirmContext);
    if (!confirm) {
        throw new Error('useConfirm must be used within ConfirmProvider');
    }
    return confirm;
}

type PendingConfirm = ConfirmOptions & {
    resolve: (value: boolean) => void;
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [pending, setPending] = useState<PendingConfirm | null>(null);
    const pendingRef = useRef<PendingConfirm | null>(null);

    const confirm = useCallback<ConfirmFn>((options) => {
        return new Promise<boolean>((resolve) => {
            const next = { ...options, resolve };
            pendingRef.current = next;
            setPending(next);
        });
    }, []);

    const close = useCallback((result: boolean) => {
        pendingRef.current?.resolve(result);
        pendingRef.current = null;
        setPending(null);
    }, []);

    useEffect(() => {
        if (!pending) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [pending, close]);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            {pending && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
                    role="presentation"
                    onClick={() => close(false)}
                >
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="confirm-dialog-title"
                        aria-describedby={
                            pending.description ? 'confirm-dialog-desc' : undefined
                        }
                        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2
                            id="confirm-dialog-title"
                            className="text-lg font-semibold text-slate-900"
                        >
                            {pending.title}
                        </h2>
                        {pending.description && (
                            <p
                                id="confirm-dialog-desc"
                                className="mt-2 text-sm leading-relaxed text-slate-600"
                            >
                                {pending.description}
                            </p>
                        )}
                        <div className="mt-6 flex justify-end gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => close(false)}
                            >
                                {pending.cancelLabel ?? 'Cancel'}
                            </Button>
                            <Button
                                type="button"
                                variant={
                                    pending.variant === 'destructive'
                                        ? 'destructive'
                                        : 'default'
                                }
                                onClick={() => close(true)}
                            >
                                {pending.confirmLabel ?? 'Confirm'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </ConfirmContext.Provider>
    );
}
