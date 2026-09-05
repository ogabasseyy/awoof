/**
 * Admin Universities Management
 *
 * CRUD, pagination, search, CSV import, segment stats
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { GraduationCap, Plus, Edit2, Trash2, Download } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import apiClient from '@/lib/api-client';
import { primaryNavItems, secondaryNavItems } from '../adminNav';
import toast from 'react-hot-toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';

interface University {
    id: string;
    name: string;
    domain?: string;
    shortcode?: string;
    segment?: string;
    country?: string;
    emailDomains?: string[];
    isActive: boolean;
}

interface SegmentStats {
    federal?: { universityCount: number; studentCount: number };
    state?: { universityCount: number; studentCount: number };
    private?: { universityCount: number; studentCount: number };
}

export default function AdminUniversitiesPage() {
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [universities, setUniversities] = useState<University[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [limit] = useState(20);
    const [search, setSearch] = useState('');
    const [segmentStats, setSegmentStats] = useState<SegmentStats>({});
    const [isLoading, setIsLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingUniversity, setEditingUniversity] = useState<University | null>(null);
    const [formData, setFormData] = useState({
        name: '',
        domain: '',
        emailDomains: '',
        segment: '',
        country: 'Nigeria',
    });
    const [csvFile, setCsvFile] = useState<File | null>(null);
    const [importing, setImporting] = useState(false);

    const handleLogout = async () => {
        await logout();
    };

    const fetchUniversities = useCallback(async () => {
        try {
            setIsLoading(true);
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (search.trim()) params.set('search', search.trim());
            const res = await apiClient.get(`/admin/universities?${params}`);
            setUniversities(res.data.data?.universities ?? []);
            setTotal(res.data.data?.total ?? 0);
        } catch {
            setUniversities([]);
            setTotal(0);
        } finally {
            setIsLoading(false);
        }
    }, [page, limit, search]);

    const fetchSegmentStats = useCallback(async () => {
        try {
            const res = await apiClient.get('/admin/universities/segment-stats');
            setSegmentStats(res.data.data?.segmentStats ?? {});
        } catch {
            setSegmentStats({});
        }
    }, []);

    useEffect(() => {
        fetchUniversities();
    }, [fetchUniversities]);

    useEffect(() => {
        fetchSegmentStats();
    }, [fetchSegmentStats]);

    const handleOpenModal = (university?: University) => {
        if (university) {
            setEditingUniversity(university);
            setFormData({
                name: university.name,
                domain: university.domain || '',
                emailDomains: Array.isArray(university.emailDomains) ? university.emailDomains.join(', ') : '',
                segment: university.segment || '',
                country: university.country || 'Nigeria',
            });
        } else {
            setEditingUniversity(null);
            setFormData({ name: '', domain: '', emailDomains: '', segment: '', country: 'Nigeria' });
        }
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingUniversity(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const emailDomains = formData.emailDomains
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const payload = {
                name: formData.name,
                domain: formData.domain,
                email_domains: emailDomains.length ? emailDomains : [formData.domain],
                segment: formData.segment || undefined,
                country: formData.country || undefined,
            };
            if (editingUniversity) {
                await apiClient.put(`/admin/universities/${editingUniversity.id}`, payload);
                toast.success('University updated');
            } else {
                await apiClient.post('/admin/universities', payload);
                toast.success('University created');
            }
            handleCloseModal();
            fetchUniversities();
            fetchSegmentStats();
        } catch (err) {
            const e = err as { response?: { data?: { error?: { message?: string } } } };
            toast.error(e.response?.data?.error?.message || 'Failed to save university');
        }
    };

    const handleDelete = async (id: string) => {
        const ok = await confirm({
            title: 'Delete university?',
            description: 'This will remove the university from the platform.',
            confirmLabel: 'Delete',
            variant: 'destructive',
        });
        if (!ok) return;
        try {
            await apiClient.delete(`/admin/universities/${id}`);
            fetchUniversities();
            fetchSegmentStats();
            toast.success('University deleted');
        } catch (err) {
            const e = err as { response?: { data?: { error?: { message?: string } } } };
            toast.error(e.response?.data?.error?.message || 'Failed to delete');
        }
    };

    const handleDownloadSample = async () => {
        try {
            const res = await apiClient.get('/admin/universities/csv-sample', { responseType: 'text' });
            const blob = new Blob([res.data], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'universities_sample.csv';
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Sample CSV downloaded');
        } catch {
            toast.error('Failed to download sample CSV');
        }
    };

    const handleImportCsv = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!csvFile) {
            toast.error('Please select a CSV file');
            return;
        }
        try {
            setImporting(true);
            const formDataUpload = new FormData();
            formDataUpload.append('file', csvFile);
            await apiClient.post('/admin/universities/import-csv', formDataUpload);
            setCsvFile(null);
            fetchUniversities();
            fetchSegmentStats();
            toast.success('CSV imported successfully');
        } catch (err) {
            const e = err as { response?: { data?: { error?: { message?: string } } } };
            toast.error(e.response?.data?.error?.message || 'Failed to import CSV');
        } finally {
            setImporting(false);
        }
    };

    const totalPages = Math.ceil(total / limit);

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Universities Management"
                user={user as User}
                onLogout={handleLogout}
                logoutLabel="Logout"
                topbarActions={
                    <Button onClick={() => handleOpenModal()}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add University
                    </Button>
                }
            >
                <div className="space-y-6">
                    {/* Segment stats */}
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        {(['federal', 'state', 'private'] as const).map((seg) => (
                            <div key={seg} className="rounded-lg bg-white p-4 shadow-sm">
                                <h3 className="text-sm font-medium text-slate-600 capitalize">{seg}</h3>
                                <p className="mt-2 text-2xl font-semibold text-slate-900">
                                    {(segmentStats[seg]?.universityCount ?? 0)} universities, {(segmentStats[seg]?.studentCount ?? 0)} students
                                </p>
                            </div>
                        ))}
                    </div>

                    {/* CSV import */}
                    <div className="rounded-lg bg-white p-4 shadow-sm">
                        <h3 className="text-sm font-medium text-slate-900 mb-2">Import from CSV</h3>
                        <p className="text-sm text-slate-600 mb-3">
                            Download the sample to see the expected columns (name, domain, email_domains, segment, country).
                        </p>
                        <div className="flex flex-wrap gap-3 items-center">
                            <Button type="button" variant="outline" size="sm" onClick={handleDownloadSample}>
                                <Download className="mr-2 h-4 w-4" />
                                Download sample CSV
                            </Button>
                            <form onSubmit={handleImportCsv} className="flex gap-3 items-center">
                                <input
                                    type="file"
                                    accept=".csv"
                                    onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
                                    className="text-sm"
                                />
                                <Button type="submit" disabled={!csvFile || importing}>
                                    {importing ? 'Importing...' : 'Import'}
                                </Button>
                            </form>
                        </div>
                    </div>

                    {/* Search */}
                    <div className="flex gap-3">
                        <Input
                            placeholder="Search by name, domain, shortcode..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && fetchUniversities()}
                            className="max-w-sm"
                        />
                        <Button variant="outline" onClick={fetchUniversities}>Search</Button>
                    </div>

                    {/* Table */}
                    {isLoading ? (
                        <div className="py-12 text-center text-slate-500">Loading...</div>
                    ) : universities.length === 0 ? (
                        <div className="rounded-lg bg-white p-12 text-center shadow-sm">
                            <GraduationCap className="mx-auto h-12 w-12 text-slate-400" />
                            <h3 className="mt-4 text-lg font-semibold text-slate-900">No universities yet</h3>
                            <p className="mt-2 text-sm text-slate-500">Add universities or import from CSV</p>
                            <Button onClick={() => handleOpenModal()} className="mt-6">
                                <Plus className="mr-2 h-4 w-4" />
                                Add University
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-lg bg-white shadow-sm overflow-x-auto">
                                <table className="w-full">
                                    <thead className="border-b bg-slate-50">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Name</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Domain</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Shortcode</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Segment</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Country</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase text-slate-700">Active</th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase text-slate-700">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {universities.map((u) => (
                                            <tr key={u.id} className="hover:bg-slate-50">
                                                <td className="px-6 py-4 text-sm font-medium text-slate-900">{u.name}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{u.domain || '-'}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{u.shortcode || '-'}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{u.segment ? u.segment.charAt(0).toUpperCase() + u.segment.slice(1) : '-'}</td>
                                                <td className="px-6 py-4 text-sm text-slate-600">{u.country || '-'}</td>
                                                <td className="px-6 py-4 text-sm">{u.isActive ? 'Yes' : 'No'}</td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex justify-end gap-2">
                                                        <Button variant="ghost" size="sm" onClick={() => handleOpenModal(u)}>
                                                            <Edit2 className="h-4 w-4" />
                                                        </Button>
                                                        <Button variant="ghost" size="sm" className="text-red-600" onClick={() => handleDelete(u.id)}>
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
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

                {/* Modal */}
                {isModalOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
                        <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
                            <h2 className="text-lg font-semibold mb-4">
                                {editingUniversity ? 'Edit University' : 'Add University'}
                            </h2>
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div>
                                    <Label htmlFor="name">Name *</Label>
                                    <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
                                </div>
                                <div>
                                    <Label htmlFor="domain">Domain *</Label>
                                    <Input id="domain" value={formData.domain} onChange={(e) => setFormData({ ...formData, domain: e.target.value })} required placeholder="e.g. unilag.edu.ng" />
                                </div>
                                <div>
                                    <Label htmlFor="emailDomains">Email Domains (comma-separated)</Label>
                                    <Input id="emailDomains" value={formData.emailDomains} onChange={(e) => setFormData({ ...formData, emailDomains: e.target.value })} placeholder="unilag.edu.ng, live.unilag.edu.ng" />
                                </div>
                                <div>
                                    <Label htmlFor="segment">Segment</Label>
                                    <select
                                        id="segment"
                                        value={formData.segment}
                                        onChange={(e) => setFormData({ ...formData, segment: e.target.value })}
                                        className="w-full rounded-md border border-slate-300 px-3 py-2"
                                    >
                                        <option value="">Select</option>
                                        <option value="federal">Federal</option>
                                        <option value="state">State</option>
                                        <option value="private">Private</option>
                                    </select>
                                </div>
                                <div>
                                    <Label htmlFor="country">Country</Label>
                                    <Input id="country" value={formData.country} onChange={(e) => setFormData({ ...formData, country: e.target.value })} />
                                </div>
                                <div className="flex justify-end gap-3 pt-4">
                                    <Button type="button" variant="outline" onClick={handleCloseModal}>Cancel</Button>
                                    <Button type="submit">{editingUniversity ? 'Update' : 'Create'}</Button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </DashboardLayout>
        </ProtectedRoute>
    );
}
