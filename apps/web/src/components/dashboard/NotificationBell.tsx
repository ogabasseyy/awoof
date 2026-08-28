'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell } from 'lucide-react';
import apiClient from '@/lib/api-client';

interface BellNotification {
    id: string;
    title: string;
    message: string;
    read: boolean;
    kind?: string | null;
    metadata?: { ticketId?: string; transactionId?: string } | null;
    createdAt: string;
}

function inboxHref(pathname: string | null): string {
    if (pathname?.startsWith('/admin')) return '/admin/notifications';
    if (pathname?.startsWith('/vendor')) return '/vendor/notifications';
    return '/student/profile/notifications';
}

function deepLink(n: BellNotification, pathname: string | null): string | null {
    const ticketId = n.metadata?.ticketId;
    if (ticketId) {
        if (pathname?.startsWith('/admin')) return `/admin/support/${ticketId}`;
        if (pathname?.startsWith('/vendor')) return `/vendor/support/${ticketId}`;
        return `/student/profile/support/${ticketId}`;
    }
    if (n.kind === 'order' && pathname?.startsWith('/vendor')) return '/vendor/orders';
    if (n.kind === 'purchase') return '/student/profile/receipts';
    return null;
}

export function NotificationBell() {
    const pathname = usePathname();
    const [open, setOpen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const [items, setItems] = useState<BellNotification[]>([]);
    const ref = useRef<HTMLDivElement | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [countRes, listRes] = await Promise.all([
                apiClient.get('/support/notifications/unread-count'),
                apiClient.get('/support/notifications', { params: { limit: 8 } }),
            ]);
            setUnreadCount(countRes?.data?.data?.unreadCount ?? 0);
            setItems(listRes?.data?.data?.notifications ?? []);
        } catch {
            // Bell is best-effort; ignore when unauthenticated on public shells
        }
    }, []);

    useEffect(() => {
        void refresh();
        const id = window.setInterval(() => void refresh(), 45000);
        return () => window.clearInterval(id);
    }, [refresh]);

    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [open]);

    const markOne = async (id: string) => {
        try {
            await apiClient.put(`/support/notifications/${id}/read`);
            setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
            setUnreadCount((c) => Math.max(0, c - 1));
        } catch {
            /* ignore */
        }
    };

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => {
                    setOpen((o) => !o);
                    void refresh();
                }}
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition-colors hover:bg-slate-100"
                aria-label="Notifications"
            >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                    <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#1D4ED8] px-1 text-[10px] font-semibold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                        <p className="text-sm font-semibold text-slate-900">Notifications</p>
                        <Link
                            href={inboxHref(pathname)}
                            className="text-xs font-medium text-[#1D4ED8]"
                            onClick={() => setOpen(false)}
                        >
                            View all
                        </Link>
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                        {items.length === 0 ? (
                            <p className="px-4 py-8 text-center text-sm text-slate-500">No notifications</p>
                        ) : (
                            items.map((n) => {
                                const href = deepLink(n, pathname);
                                const content = (
                                    <>
                                        <p className="text-sm font-medium text-slate-900">{n.title}</p>
                                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{n.message}</p>
                                    </>
                                );
                                return (
                                    <div
                                        key={n.id}
                                        className={`border-b border-slate-50 px-4 py-3 ${n.read ? '' : 'bg-blue-50/40'}`}
                                    >
                                        {href ? (
                                            <Link
                                                href={href}
                                                onClick={() => {
                                                    void markOne(n.id);
                                                    setOpen(false);
                                                }}
                                            >
                                                {content}
                                            </Link>
                                        ) : (
                                            <button
                                                type="button"
                                                className="w-full text-left"
                                                onClick={() => void markOne(n.id)}
                                            >
                                                {content}
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
