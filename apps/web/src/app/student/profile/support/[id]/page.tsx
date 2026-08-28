'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Button } from '@/components/ui/button';
import { TicketThread, type TicketMessageView, type TicketView } from '@/components/support/TicketThread';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';

export default function StudentTicketDetailPage() {
    const params = useParams();
    const id = String(params.id);
    const [ticket, setTicket] = useState<TicketView | null>(null);
    const [messages, setMessages] = useState<TicketMessageView[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const res = await apiClient.get(`/students/support-tickets/${id}`);
            setTicket(res.data.data.ticket);
            setMessages(res.data.data.messages || []);
        } catch {
            toast.error('Could not load ticket');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    const onReply = async (body: string) => {
        await apiClient.post(`/students/support-tickets/${id}/messages`, { body });
        toast.success('Reply sent');
        await load();
    };

    return (
        <ProtectedRoute requiredRole="student">
            <div className="min-h-screen bg-[#F4F7FD] px-4 py-6 sm:px-6">
                <div className="mx-auto max-w-3xl">
                    <Link href="/student/profile/support">
                        <Button variant="ghost" size="sm" className="mb-4">
                            <ChevronLeft className="mr-2 h-4 w-4" />
                            Back to support
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
                </div>
            </div>
        </ProtectedRoute>
    );
}
