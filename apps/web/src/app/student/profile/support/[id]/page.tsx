'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Button } from '@/components/ui/button';
import { TicketThread, type TicketMessageView, type TicketView } from '@/components/support/TicketThread';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';
import { useAuth } from '@/contexts/AuthContext';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';

function sessionGeneration() {
    return getSessionSnapshot().generation;
}

function serverSessionGeneration() {
    return 0;
}

export default function StudentTicketDetailPage() {
    const params = useParams();
    const id = String(params.id);
    const { user } = useAuth();
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverSessionGeneration);

    return (
        <ProtectedRoute requiredRole="student">
            <StudentTicketDetail key={`${generation}:${user?.id}:${id}`} id={id} />
        </ProtectedRoute>
    );
}

function StudentTicketDetail({ id }: { id: string }) {
    const [session] = useState(getSessionSnapshot);
    const [ticket, setTicket] = useState<TicketView | null>(null);
    const [messages, setMessages] = useState<TicketMessageView[]>([]);
    const [loading, setLoading] = useState(true);
    const active = useRef(false);
    const requestSequence = useRef(0);

    const load = useCallback(async () => {
        if (!active.current || !isCurrentSession(session)) return;
        const sequence = ++requestSequence.current;
        const current = () => active.current && sequence === requestSequence.current && isCurrentSession(session);
        try {
            const res = await apiClient.get(`/students/support-tickets/${id}`);
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
        await apiClient.post(`/students/support-tickets/${id}/responses`, { body });
        if (!active.current || !isCurrentSession(session)) return;
        toast.success('Reply sent');
        await load();
    };

    return (
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
    );
}
