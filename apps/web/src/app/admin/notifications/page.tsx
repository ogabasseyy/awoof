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

    const load = async () => {
        try {
            setLoading(true);
            const res = await apiClient.get('/support/notifications');
            setNotifications(res.data.data.notifications || []);
        } catch {
            setNotifications([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, []);

    const markAll = async () => {
        await apiClient.put('/support/notifications/read', { markAll: true });
        await load();
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
            </DashboardLayout>
        </ProtectedRoute>
    );
}
