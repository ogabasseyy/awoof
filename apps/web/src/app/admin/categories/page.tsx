/**
 * Admin Categories Management
 */

'use client';

import { useState, useEffect } from 'react';
import { Tag, Plus, Edit2, Trash2 } from 'lucide-react';
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

interface Category {
    id: string;
    name: string;
    description: string | null;
    slug: string | null;
    productCount: number;
    createdAt: string;
    updatedAt: string;
}

export default function AdminCategoriesPage() {
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [categories, setCategories] = useState<Category[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCategory, setEditingCategory] = useState<Category | null>(null);
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        slug: '',
    });

    const handleLogout = async () => {
        await logout();
    };

    const fetchCategories = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get('/admin/categories');
            setCategories(response.data.data || []);
        } catch (error) {
            console.error('Error fetching categories:', error);
            toast.error('Failed to fetch categories');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchCategories();
    }, []);

    const handleOpenModal = (category?: Category) => {
        if (category) {
            setEditingCategory(category);
            setFormData({
                name: category.name,
                description: category.description || '',
                slug: category.slug || '',
            });
        } else {
            setEditingCategory(null);
            setFormData({
                name: '',
                description: '',
                slug: '',
            });
        }
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingCategory(null);
        setFormData({
            name: '',
            description: '',
            slug: '',
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            if (editingCategory) {
                await apiClient.put(`/admin/categories/${editingCategory.id}`, formData);
                toast.success('Category updated successfully');
            } else {
                await apiClient.post('/admin/categories', formData);
                toast.success('Category created successfully');
            }
            handleCloseModal();
            fetchCategories();
        } catch (error) {
            console.error('Error saving category:', error);
            const message = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message || 'Failed to save category';
            toast.error(message);
        }
    };

    const handleDelete = async (categoryId: string) => {
        const ok = await confirm({
            title: 'Delete category?',
            description: 'This action cannot be undone.',
            confirmLabel: 'Delete',
            variant: 'destructive',
        });
        if (!ok) return;

        try {
            await apiClient.delete(`/admin/categories/${categoryId}`);
            toast.success('Category deleted successfully');
            fetchCategories();
        } catch (error) {
            console.error('Error deleting category:', error);
            const message = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message || 'Failed to delete category';
            toast.error(message);
        }
    };

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Categories Management"
                user={user as User}
                onLogout={handleLogout}
                logoutLabel="Logout"
                topbarActions={
                    <Button onClick={() => handleOpenModal()}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Category
                    </Button>
                }
            >
                <div className="space-y-6">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <p className="text-slate-500">Loading categories...</p>
                        </div>
                    ) : categories.length === 0 ? (
                        <div className="rounded-lg bg-white p-12 text-center shadow-sm">
                            <Tag className="mx-auto h-12 w-12 text-slate-400" />
                            <h3 className="mt-4 text-lg font-semibold text-slate-900">No categories yet</h3>
                            <p className="mt-2 text-sm text-slate-500">Get started by creating your first category</p>
                            <Button onClick={() => handleOpenModal()} className="mt-6">
                                <Plus className="mr-2 h-4 w-4" />
                                Add Category
                            </Button>
                        </div>
                    ) : (
                        <div className="rounded-lg bg-white shadow-sm">
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="border-b border-slate-200 bg-slate-50">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Name
                                            </th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Description
                                            </th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Slug
                                            </th>
                                            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Products
                                            </th>
                                            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Actions
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200 bg-white">
                                        {categories.map((category) => (
                                            <tr key={category.id} className="hover:bg-slate-50">
                                                <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-slate-900">
                                                    {category.name}
                                                </td>
                                                <td className="px-6 py-4 text-sm text-slate-500">
                                                    {category.description || '-'}
                                                </td>
                                                <td className="px-6 py-4 text-sm text-slate-500">
                                                    {category.slug || '-'}
                                                </td>
                                                <td className="px-6 py-4 text-sm text-slate-500">
                                                    {category.productCount}
                                                </td>
                                                <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
                                                    <div className="flex justify-end gap-2">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => handleOpenModal(category)}
                                                        >
                                                            <Edit2 className="h-4 w-4" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => handleDelete(category.id)}
                                                            className="text-red-600 hover:text-red-700"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                {/* Modal */}
                {isModalOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
                        <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
                            <h2 className="text-lg font-semibold text-slate-900 mb-4">
                                {editingCategory ? 'Edit Category' : 'Create Category'}
                            </h2>
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div>
                                    <Label htmlFor="name">Name *</Label>
                                    <Input
                                        id="name"
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        required
                                        placeholder="e.g., Travel, Food, Shopping"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="description">Description</Label>
                                    <Input
                                        id="description"
                                        value={formData.description}
                                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                        placeholder="Category description (optional)"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="slug">Slug</Label>
                                    <Input
                                        id="slug"
                                        value={formData.slug}
                                        onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                                        placeholder="URL-friendly slug (auto-generated if empty)"
                                    />
                                    <p className="mt-1 text-xs text-slate-500">
                                        Leave empty to auto-generate from name
                                    </p>
                                </div>
                                <div className="flex justify-end gap-3 pt-4">
                                    <Button type="button" variant="outline" onClick={handleCloseModal}>
                                        Cancel
                                    </Button>
                                    <Button type="submit">
                                        {editingCategory ? 'Update' : 'Create'}
                                    </Button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </DashboardLayout>
        </ProtectedRoute>
    );
}


