'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export interface TicketMessageView {
    id: string;
    authorRole: string;
    authorEmail?: string | null;
    body: string;
    isInternal?: boolean;
    createdAt: string;
}

export interface TicketView {
    id: string;
    subject: string;
    category: string;
    status: string;
    priority?: string;
    requesterRole?: string;
    requesterEmail?: string | null;
    requesterName?: string | null;
    createdAt: string;
    updatedAt: string;
}

interface TicketThreadProps {
    ticket: TicketView;
    messages: TicketMessageView[];
    canReply: boolean;
    showInternalToggle?: boolean;
    onReply: (body: string, isInternal?: boolean) => Promise<void>;
    statusControl?: React.ReactNode;
}

function statusClass(status: string) {
    switch (status) {
        case 'open':
            return 'bg-blue-100 text-blue-800';
        case 'in-progress':
            return 'bg-amber-100 text-amber-800';
        case 'resolved':
            return 'bg-emerald-100 text-emerald-800';
        case 'closed':
            return 'bg-slate-100 text-slate-700';
        default:
            return 'bg-slate-100 text-slate-700';
    }
}

export function TicketThread({
    ticket,
    messages,
    canReply,
    showInternalToggle,
    onReply,
    statusControl,
}: TicketThreadProps) {
    const [body, setBody] = useState('');
    const [isInternal, setIsInternal] = useState(false);
    const [sending, setSending] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!body.trim()) return;
        setSending(true);
        try {
            await onReply(body.trim(), showInternalToggle ? isInternal : false);
            setBody('');
            setIsInternal(false);
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-semibold text-slate-900">{ticket.subject}</h1>
                        <p className="mt-1 text-sm text-slate-500">
                            {ticket.category}
                            {ticket.requesterRole ? ` · ${ticket.requesterRole}` : ''}
                            {ticket.requesterName || ticket.requesterEmail
                                ? ` · ${ticket.requesterName || ticket.requesterEmail}`
                                : ''}
                        </p>
                    </div>
                    <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusClass(ticket.status)}`}
                    >
                        {ticket.status}
                    </span>
                </div>
                {statusControl && <div className="mt-4 border-t border-slate-100 pt-4">{statusControl}</div>}
            </div>

            <div className="space-y-3">
                {messages.map((m) => (
                    <div
                        key={m.id}
                        className={`rounded-xl border p-4 ${
                            m.isInternal
                                ? 'border-amber-200 bg-amber-50'
                                : m.authorRole === 'admin'
                                  ? 'border-blue-100 bg-blue-50/60'
                                  : 'border-slate-200 bg-white'
                        }`}
                    >
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-medium capitalize text-slate-700">{m.authorRole}</span>
                            {m.authorEmail && <span>{m.authorEmail}</span>}
                            {m.isInternal && (
                                <span className="rounded bg-amber-200 px-1.5 py-0.5 font-medium text-amber-900">
                                    Internal
                                </span>
                            )}
                            <span className="ml-auto">
                                {new Date(m.createdAt).toLocaleString()}
                            </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-slate-800">{m.body}</p>
                    </div>
                ))}
            </div>

            {canReply && (
                <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                    <Label htmlFor="reply">Reply</Label>
                    <Textarea
                        id="reply"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={4}
                        placeholder="Write your reply…"
                        required
                    />
                    {showInternalToggle && (
                        <label className="flex items-center gap-2 text-sm text-slate-600">
                            <input
                                type="checkbox"
                                checked={isInternal}
                                onChange={(e) => setIsInternal(e.target.checked)}
                            />
                            Internal note (hidden from requester)
                        </label>
                    )}
                    <Button type="submit" disabled={sending || !body.trim()}>
                        <Send className="mr-2 h-4 w-4" />
                        {sending ? 'Sending…' : 'Send reply'}
                    </Button>
                </form>
            )}
        </div>
    );
}
