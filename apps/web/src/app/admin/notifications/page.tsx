'use client';

import { useEffect, useState } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import { Button } from '@/components/ui/button';
import { primaryNavItems, secondaryNavItems } from '../adminNav';
import apiClient from '@/lib/api-client';

interface Notification {
    id: string;
    title: string;
    message: string;
    type: string;
    read: boolean;
    createdAt: string;
}

export default function AdminNotificationsPage() {
    const { user, logout } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                setLoading(true);
                const res = await apiClient.get('/support/notifications', { params: { page, limit: 20 } });
                if (cancelled) return;
                setNotifications(res.data.data.notifications || []);
                const pages = res.data.data.pagination.totalPages;
                setTotalPages(pages);
                if (page > pages) setPage(pages);
            } catch {
                if (!cancelled) setNotifications([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [page, refresh]);

    const markAll = async () => {
        await apiClient.put('/support/notifications/read', { markAll: true });
        setRefresh((value) => value + 1);
    };

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Notifications"
                user={{
                    name: user?.email ?? 'Admin',
                    email: user?.email,
                    roleLabel: 'Admin',
                    profileHref: '/admin/settings',
                }}
                onLogout={logout}
            >
                <div className="mb-4 flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => void markAll()}>
                        Mark all read
                    </Button>
                </div>
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    {loading ? (
                        <p className="p-6 text-sm text-slate-500">Loading…</p>
                    ) : notifications.length === 0 ? (
                        <p className="p-6 text-sm text-slate-500">No notifications</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {notifications.map((n) => (
                                <li
                                    key={n.id}
                                    className={`px-4 py-4 ${n.read ? '' : 'bg-blue-50/40'}`}
                                >
                                    <p className="font-medium text-slate-900">{n.title}</p>
                                    <p className="mt-1 text-sm text-slate-600">{n.message}</p>
                                    <p className="mt-2 text-xs text-slate-400">
                                        {new Date(n.createdAt).toLocaleString()}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <nav aria-label="Notification pages" className="mt-4 flex items-center justify-between">
                    <Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>
                        Previous
                    </Button>
                    <span className="text-sm text-slate-600">Page {page} of {totalPages}</span>
                    <Button variant="outline" disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}>
                        Next
                    </Button>
                </nav>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
