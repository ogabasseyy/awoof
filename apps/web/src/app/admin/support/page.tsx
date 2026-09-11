'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import { primaryNavItems, secondaryNavItems } from '../adminNav';
import apiClient from '@/lib/api-client';

interface TicketRow {
    id: string;
    subject: string;
    status: string;
    requesterRole: string;
    requesterEmail?: string | null;
    requesterName?: string | null;
    category: string;
    messageCount?: number;
    updatedAt: string;
}

export default function AdminSupportPage() {
    const { user, logout } = useAuth();
    const [tickets, setTickets] = useState<TicketRow[]>([]);
    const [status, setStatus] = useState('');
    const [role, setRole] = useState('');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                setLoading(true);
                const res = await apiClient.get('/admin/support/tickets', {
                    params: {
                        page,
                        limit: 20,
                        ...(status ? { status } : {}),
                        ...(role ? { role } : {}),
                        ...(search.trim() ? { search: search.trim() } : {}),
                    },
                });
                if (!cancelled) {
                    setTickets(res.data.data.tickets || []);
                    setTotalPages(res.data.data.pagination?.totalPages || 1);
                }
            } catch {
                if (!cancelled) setTickets([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [status, role, search, page]);

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Support"
                subtitle="Shared inbox for student and vendor tickets"
                user={{
                    name: user?.email ?? 'Admin',
                    email: user?.email,
                    roleLabel: 'Admin',
                    profileHref: '/admin/settings',
                }}
                onLogout={logout}
            >
                <div className="mb-4 flex flex-wrap gap-3">
                    <select
                        value={status}
                        onChange={(e) => { setPage(1); setStatus(e.target.value); }}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                        <option value="">All statuses</option>
                        <option value="open">Open</option>
                        <option value="in-progress">In progress</option>
                        <option value="resolved">Resolved</option>
                        <option value="closed">Closed</option>
                    </select>
                    <select
                        value={role}
                        onChange={(e) => { setPage(1); setRole(e.target.value); }}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                        <option value="">All roles</option>
                        <option value="student">Student</option>
                        <option value="vendor">Vendor</option>
                    </select>
                    <input
                        value={search}
                        onChange={(e) => { setPage(1); setSearch(e.target.value); }}
                        placeholder="Search subject or email"
                        className="min-w-[200px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                </div>

                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    {loading ? (
                        <p className="p-6 text-sm text-slate-500">Loading…</p>
                    ) : tickets.length === 0 ? (
                        <p className="p-6 text-sm text-slate-500">No tickets found</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {tickets.map((t) => (
                                <li key={t.id}>
                                    <Link
                                        href={`/admin/support/${t.id}`}
                                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 hover:bg-slate-50"
                                    >
                                        <div>
                                            <p className="font-medium text-slate-900">{t.subject}</p>
                                            <p className="text-xs text-slate-500">
                                                {t.requesterRole}
                                                {t.requesterName || t.requesterEmail
                                                    ? ` · ${t.requesterName || t.requesterEmail}`
                                                    : ''}
                                                {` · ${t.category}`}
                                                {t.messageCount != null ? ` · ${t.messageCount} msgs` : ''}
                                            </p>
                                        </div>
                                        <div className="text-right text-xs text-slate-500">
                                            <p className="capitalize font-medium text-slate-700">{t.status}</p>
                                            <p>{new Date(t.updatedAt).toLocaleString()}</p>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <nav aria-label="Support ticket pages" className="mt-4 flex items-center gap-4">
                    <button disabled={loading || page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span>Page {page} of {totalPages}</span>
                    <button disabled={loading || page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
                </nav>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
