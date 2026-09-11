/**
 * Admin Students
 *
 * List students with spend and savings.
 */

'use client';

import { formatSavings } from '@/lib/format';

import { useState, useEffect, useCallback } from 'react';
import { Users } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import apiClient from '@/lib/api-client';
import { primaryNavItems, secondaryNavItems } from '../adminNav';

interface Student {
    id: string;
    userId: string;
    name: string;
    email: string;
    university: string | null;
    registrationNumber: string | null;
    phoneNumber: string | null;
    status: string;
    verificationDate: string | null;
    createdAt: string;
    totalSpent: number;
    totalSavings: number | null;
    recordedSavings?: number;
}

function formatCurrency(n: number): string {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'short' });
}

export default function AdminStudentsPage() {
    const { user, logout } = useAuth();
    const [students, setStudents] = useState<Student[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [limit] = useState(20);
    const [search, setSearch] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    const handleLogout = async () => {
        await logout();
    };

    const fetchStudents = useCallback(async () => {
        try {
            setIsLoading(true);
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (search.trim()) params.set('search', search.trim());
            const res = await apiClient.get(`/admin/students?${params}`);
            setStudents(res.data.data?.students ?? []);
            setTotal(res.data.data?.total ?? 0);
        } catch {
            setStudents([]);
            setTotal(0);
        } finally {
            setIsLoading(false);
        }
    }, [page, limit, search]);

    useEffect(() => {
        fetchStudents();
    }, [fetchStudents]);

    const totalPages = Math.ceil(total / limit);

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Students"
                user={user as User}
                onLogout={handleLogout}
                logoutLabel="Logout"
            >
                <div className="space-y-6">
                    <div className="flex gap-3">
                        <Input
                            placeholder="Search by name, email, university..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && fetchStudents()}
                            className="max-w-sm"
                        />
                        <Button variant="outline" onClick={fetchStudents}>
                            Search
                        </Button>
                    </div>

                    {isLoading ? (
                        <div className="py-12 text-center text-slate-500">Loading...</div>
                    ) : students.length === 0 ? (
                        <div className="rounded-lg bg-white p-12 text-center shadow-sm">
                            <Users className="mx-auto h-12 w-12 text-slate-400" />
                            <h3 className="mt-4 text-lg font-semibold text-slate-900">No students found</h3>
                            <p className="mt-2 text-sm text-slate-500">Try a different search or check back later.</p>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-lg bg-white shadow-sm overflow-x-auto">
                                <table className="w-full">
                                    <thead className="border-b bg-slate-50">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Name</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Email</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">University</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Reg no.</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Status</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Spent</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Saved</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {students.map((s) => (
                                            <tr key={s.id} className="hover:bg-slate-50">
                                                <td className="px-6 py-4 text-sm font-medium text-slate-900">{s.name}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{s.email}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{s.university || '-'}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{s.registrationNumber || '-'}</td>
                                                <td className="px-6 py-4 text-sm capitalize text-slate-600">{s.status}</td>
                                                <td className="px-6 py-4 text-sm text-right font-medium text-slate-900">{formatCurrency(s.totalSpent)}</td>
                                                <td className="px-6 py-4 text-sm text-right font-medium text-green-600">{formatSavings(s.totalSavings, s.recordedSavings)}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{formatDate(s.createdAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {totalPages > 1 && (
                                <div className="flex justify-between items-center">
                                    <p className="text-sm text-slate-600">
                                        Page {page} of {totalPages} ({total} total)
                                    </p>
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                                            Previous
                                        </Button>
                                        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                                            Next
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
