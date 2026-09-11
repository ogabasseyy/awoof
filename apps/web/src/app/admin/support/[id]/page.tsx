'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { DashboardLayout } from '@/components/dashboard';
import { TicketThread, type TicketMessageView, type TicketView } from '@/components/support/TicketThread';
import { primaryNavItems, secondaryNavItems } from '../../adminNav';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';

function sessionGeneration() {
    return getSessionSnapshot().generation;
}

function serverSessionGeneration() {
    return 0;
}

export default function AdminTicketDetailPage() {
    const { user } = useAuth();
    const params = useParams();
    const id = String(params.id);
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverSessionGeneration);

    return (
        <ProtectedRoute requiredRole="admin">
            <AdminTicketDetail key={`${generation}:${user?.id}:${id}`} id={id} />
        </ProtectedRoute>
    );
}

function AdminTicketDetail({ id }: { id: string }) {
    const { user, logout } = useAuth();
    const [session] = useState(getSessionSnapshot);
    const [ticket, setTicket] = useState<TicketView | null>(null);
    const [messages, setMessages] = useState<TicketMessageView[]>([]);
    const [status, setStatus] = useState('open');
    const [loading, setLoading] = useState(true);
    const active = useRef(false);
    const requestSequence = useRef(0);

    const load = useCallback(async () => {
        if (!active.current || !isCurrentSession(session)) return;
        const sequence = ++requestSequence.current;
        const current = () => active.current && sequence === requestSequence.current && isCurrentSession(session);
        try {
            const res = await apiClient.get(`/admin/support/tickets/${id}`);
            if (!current()) return;
            setTicket(res.data.data.ticket);
            setMessages(res.data.data.messages || []);
            setStatus(res.data.data.ticket?.status ?? 'open');
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

    const onReply = async (body: string, isInternal?: boolean) => {
        if (!active.current || !isCurrentSession(session)) return;
        await apiClient.post(`/admin/support/tickets/${id}/messages`, { body, isInternal });
        if (!active.current || !isCurrentSession(session)) return;
        toast.success(isInternal ? 'Internal note saved' : 'Reply sent');
        await load();
    };

    const onStatus = async () => {
        if (!active.current || !isCurrentSession(session)) return;
        await apiClient.patch(`/admin/support/tickets/${id}`, { status });
        if (!active.current || !isCurrentSession(session)) return;
        toast.success('Status updated');
        await load();
    };

    return (
        <DashboardLayout
            navItems={primaryNavItems}
            secondaryNavItems={secondaryNavItems}
            pageTitle="Ticket"
            user={{
                name: user?.email ?? 'Admin',
                email: user?.email,
                roleLabel: 'Admin',
                profileHref: '/admin/settings',
            }}
            onLogout={logout}
        >
            <Link href="/admin/support">
                <Button variant="ghost" size="sm" className="mb-4">
                    <ChevronLeft className="mr-2 h-4 w-4" />
                    Back to inbox
                </Button>
            </Link>
            {loading || !ticket ? (
                <p className="text-slate-500">{loading ? 'Loading…' : 'Ticket not found'}</p>
            ) : (
                <TicketThread
                    ticket={ticket}
                    messages={messages}
                    canReply
                    showInternalToggle
                    onReply={onReply}
                    statusControl={
                        <div className="flex flex-wrap items-center gap-3">
                            <select
                                value={status}
                                onChange={(e) => setStatus(e.target.value)}
                                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                            >
                                <option value="open">Open</option>
                                <option value="in-progress">In progress</option>
                                <option value="resolved">Resolved</option>
                                <option value="closed">Closed</option>
                            </select>
                            <Button type="button" variant="outline" onClick={() => void onStatus()}>
                                Update status
                            </Button>
                        </div>
                    }
                />
            )}
        </DashboardLayout>
    );
}
