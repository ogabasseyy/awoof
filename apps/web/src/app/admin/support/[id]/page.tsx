'use client';

import { useCallback, useEffect, useState } from 'react';
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

export default function AdminTicketDetailPage() {
    const { user, logout } = useAuth();
    const params = useParams();
    const id = String(params.id);
    const [ticket, setTicket] = useState<TicketView | null>(null);
    const [messages, setMessages] = useState<TicketMessageView[]>([]);
    const [status, setStatus] = useState('open');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const res = await apiClient.get(`/admin/support/tickets/${id}`);
            setTicket(res.data.data.ticket);
            setMessages(res.data.data.messages || []);
            setStatus(res.data.data.ticket.status);
        } catch {
            toast.error('Could not load ticket');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    const onReply = async (body: string, isInternal?: boolean) => {
        await apiClient.post(`/admin/support/tickets/${id}/messages`, { body, isInternal });
        toast.success(isInternal ? 'Internal note saved' : 'Reply sent');
        await load();
    };

    const onStatus = async () => {
        await apiClient.patch(`/admin/support/tickets/${id}`, { status });
        toast.success('Status updated');
        await load();
    };

    return (
        <ProtectedRoute requiredRole="admin">
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
        </ProtectedRoute>
    );
}
