'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
    BarChart3,
    CreditCard,
    LayoutDashboard,
    LifeBuoy,
    Puzzle,
    Settings,
    ShoppingBag,
    Tag,
    ChevronLeft,
    Bell,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { DashboardLayout } from '@/components/dashboard';
import { TicketThread, type TicketMessageView, type TicketView } from '@/components/support/TicketThread';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges, type User } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';

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

function sessionGeneration() {
    return getSessionSnapshot().generation;
}

function serverSessionGeneration() {
    return 0;
}

export default function VendorTicketDetailPage() {
    const { user } = useAuth();
    const params = useParams();
    const id = String(params.id);
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverSessionGeneration);

    return (
        <ProtectedRoute requiredRole="vendor">
            <VendorTicketDetail key={`${generation}:${user?.id}:${id}`} id={id} />
        </ProtectedRoute>
    );
}

function VendorTicketDetail({ id }: { id: string }) {
    const { user, logout } = useAuth();
    const [session] = useState(getSessionSnapshot);
    const [ticket, setTicket] = useState<TicketView | null>(null);
    const [messages, setMessages] = useState<TicketMessageView[]>([]);
    const [loading, setLoading] = useState(true);
    const active = useRef(false);
    const requestSequence = useRef(0);

    const extendedUser = user as (User & { profile?: { companyName?: string; name?: string } }) | null;
    const displayName =
        extendedUser?.profile?.companyName ??
        extendedUser?.profile?.name ??
        extendedUser?.email ??
        'Vendor';

    const load = useCallback(async () => {
        if (!active.current || !isCurrentSession(session)) return;
        const sequence = ++requestSequence.current;
        const current = () => active.current && sequence === requestSequence.current && isCurrentSession(session);
        try {
            const res = await apiClient.get(`/vendors/support-tickets/${id}`);
            if (!current()) return;
            setTicket(res.data.data.ticket);
            setMessages(res.data.data.messages || []);
        } catch {
            if (current()) toast.error('Could not load ticket');
        } finally {
            if (current()) setLoading(false);
        }
    }, [id, session]);

    useEffect(() => {
        active.current = true;
        // load updates state only after the network request settles.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
        return () => {
            active.current = false;
            requestSequence.current += 1;
        };
    }, [load]);

    const onReply = async (body: string) => {
        if (!active.current || !isCurrentSession(session)) return;
        await apiClient.post(`/vendors/support-tickets/${id}/messages`, { body });
        if (!active.current || !isCurrentSession(session)) return;
        toast.success('Reply sent');
        await load();
    };

    return (
        <DashboardLayout
            navItems={primaryNavItems}
            secondaryNavItems={secondaryNavItems}
            pageTitle="Support ticket"
            user={{
                name: displayName,
                email: user?.email,
                roleLabel: 'Vendor',
                profileHref: '/vendor/settings',
            }}
            onLogout={logout}
        >
            <Link href="/vendor/support">
                <Button variant="ghost" size="sm" className="mb-4">
                    <ChevronLeft className="mr-2 h-4 w-4" />
                    Back
                </Button>
            </Link>
            {loading || !ticket ? (
                <p className="text-slate-500">{loading ? 'Loading…' : 'Ticket not found'}</p>
            ) : (
                <TicketThread
                    ticket={ticket}
                    messages={messages}
                    canReply={ticket.status !== 'closed'}
                    onReply={onReply}
                />
            )}
        </DashboardLayout>
    );
}
