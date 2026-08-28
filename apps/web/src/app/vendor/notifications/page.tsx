'use client';

import { useEffect, useState } from 'react';
import {
    BarChart3,
    Bell,
    CreditCard,
    LayoutDashboard,
    LifeBuoy,
    Puzzle,
    Settings,
    ShoppingBag,
    Tag,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import { Button } from '@/components/ui/button';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';

const iconProps = { className: 'h-5 w-5', strokeWidth: 1.5, fill: 'currentColor' as const };

const primaryNavItems = [
    { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: <LayoutDashboard {...iconProps} /> },
    { id: 'manage-deals', label: 'Manage Deals', href: '/vendor/deals', icon: <Tag {...iconProps} /> },
    { id: 'orders', label: 'Orders', href: '/vendor/orders', icon: <ShoppingBag {...iconProps} /> },
    { id: 'analytics', label: 'Analytics', href: '/vendor/analytics', icon: <BarChart3 {...iconProps} /> },
    { id: 'payment', label: 'Payment', href: '/vendor/payment', icon: <CreditCard {...iconProps} /> },
    { id: 'integration', label: 'Integration', href: '/vendor/integration', icon: <Puzzle {...iconProps} /> },
];

const secondaryNavItems = [
    { id: 'support', label: 'Support', href: '/vendor/support', icon: <LifeBuoy {...iconProps} /> },
    { id: 'notifications', label: 'Notifications', href: '/vendor/notifications', icon: <Bell {...iconProps} /> },
    { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: <Settings {...iconProps} /> },
];

interface Notification {
    id: string;
    title: string;
    message: string;
    read: boolean;
    createdAt: string;
}

export default function VendorNotificationsPage() {
    const { user, logout } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading] = useState(true);

    const extendedUser = user as (User & { profile?: { companyName?: string; name?: string } }) | null;
    const displayName =
        extendedUser?.profile?.companyName ??
        extendedUser?.profile?.name ??
        extendedUser?.email ??
        'Vendor';

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
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Notifications"
                user={{
                    name: displayName,
                    email: user?.email,
                    roleLabel: 'Vendor',
                    profileHref: '/vendor/settings',
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
