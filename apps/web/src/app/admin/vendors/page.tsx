/**
 * Admin Vendors
 *
 * List vendors with product count, orders, revenue and commission.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShoppingBag } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import apiClient from '@/lib/api-client';
import { primaryNavItems, secondaryNavItems } from '../adminNav';
import toast from 'react-hot-toast';

interface Vendor {
    id: string;
    userId: string;
    name: string;
    email: string;
    companyName: string | null;
    businessCategory: string | null;
    businessWebsite: string | null;
    status: string;
    createdAt: string;
    productCount: number;
    orderCount: number;
    totalRevenue: number;
    totalCommission: number;
}

function formatCurrency(n: number): string {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'short' });
}

export default function AdminVendorsPage() {
    const { user, logout } = useAuth();
    const [vendors, setVendors] = useState<Vendor[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [limit] = useState(20);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [updatingId, setUpdatingId] = useState<string | null>(null);

    const handleLogout = async () => {
        await logout();
    };

    const fetchVendors = useCallback(async () => {
        try {
            setIsLoading(true);
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (search.trim()) params.set('search', search.trim());
            if (statusFilter) params.set('status', statusFilter);
            const res = await apiClient.get(`/admin/vendors?${params}`);
            setVendors(res.data.data?.vendors ?? []);
            setTotal(res.data.data?.total ?? 0);
        } catch {
            setVendors([]);
            setTotal(0);
        } finally {
            setIsLoading(false);
        }
    }, [page, limit, search, statusFilter]);

    const updateVendorStatus = async (vendorId: string, status: 'active' | 'suspended' | 'rejected') => {
        try {
            setUpdatingId(vendorId);
            await apiClient.patch(`/admin/vendors/${vendorId}/status`, { status });
            await fetchVendors();
            toast.success(
                status === 'active'
                    ? 'Vendor approved'
                    : status === 'suspended'
                      ? 'Vendor suspended'
                      : 'Vendor rejected'
            );
        } catch {
            toast.error('Failed to update vendor status');
        } finally {
            setUpdatingId(null);
        }
    };

    useEffect(() => {
        fetchVendors();
    }, [fetchVendors]);

    const totalPages = Math.ceil(total / limit);

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Vendors"
                user={user as User}
                onLogout={handleLogout}
                logoutLabel="Logout"
            >
                <div className="space-y-6">
                    <div className="flex flex-wrap gap-3">
                        <Input
                            placeholder="Search by name, email, company, category..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && fetchVendors()}
                            className="max-w-sm"
                        />
                        <select
                            value={statusFilter}
                            onChange={(e) => {
                                setStatusFilter(e.target.value);
                                setPage(1);
                            }}
                            className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700"
                        >
                            <option value="">All statuses</option>
                            <option value="pending">Pending</option>
                            <option value="active">Active</option>
                            <option value="suspended">Suspended</option>
                            <option value="rejected">Rejected</option>
                        </select>
                        <Button variant="outline" onClick={fetchVendors}>
                            Search
                        </Button>
                    </div>

                    {isLoading ? (
                        <div className="py-12 text-center text-slate-500">Loading...</div>
                    ) : vendors.length === 0 ? (
                        <div className="rounded-lg bg-white p-12 text-center shadow-sm">
                            <ShoppingBag className="mx-auto h-12 w-12 text-slate-400" />
                            <h3 className="mt-4 text-lg font-semibold text-slate-900">No vendors found</h3>
                            <p className="mt-2 text-sm text-slate-500">Try a different search or check back later.</p>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-lg bg-white shadow-sm overflow-x-auto">
                                <table className="w-full">
                                    <thead className="border-b bg-slate-50">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Vendor</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Email</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Company</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Category</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Status</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Products</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Orders</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Revenue</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Commission</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Joined</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {vendors.map((v) => (
                                            <tr key={v.id} className="hover:bg-slate-50">
                                                <td className="px-6 py-4 text-sm font-medium text-slate-900">{v.name}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{v.email}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{v.companyName || '-'}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{v.businessCategory || '-'}</td>
                                                <td className="px-6 py-4 text-sm capitalize text-slate-600">{v.status}</td>
                                                <td className="px-6 py-4 text-sm text-right text-slate-900">{v.productCount}</td>
                                                <td className="px-6 py-4 text-sm text-right text-slate-900">{v.orderCount}</td>
                                                <td className="px-6 py-4 text-sm text-right font-medium text-slate-900">{formatCurrency(v.totalRevenue)}</td>
                                                <td className="px-6 py-4 text-sm text-right font-medium text-green-600">{formatCurrency(v.totalCommission)}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{formatDate(v.createdAt)}</td>
                                                <td className="px-6 py-4 text-sm text-right">
                                                    <div className="flex justify-end gap-2">
                                                        {v.status !== 'active' && (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                disabled={updatingId === v.id}
                                                                onClick={() => updateVendorStatus(v.id, 'active')}
                                                            >
                                                                Approve
                                                            </Button>
                                                        )}
                                                        {v.status !== 'suspended' && (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                disabled={updatingId === v.id}
                                                                onClick={() => updateVendorStatus(v.id, 'suspended')}
                                                            >
                                                                Suspend
                                                            </Button>
                                                        )}
                                                        {v.status !== 'rejected' && (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                disabled={updatingId === v.id}
                                                                onClick={() => updateVendorStatus(v.id, 'rejected')}
                                                            >
                                                                Reject
                                                            </Button>
                                                        )}
                                                    </div>
                                                </td>
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
