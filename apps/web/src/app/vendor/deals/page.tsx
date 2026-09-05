/**
 * Vendor Manage Deals Page
 * 
 * Product management interface for vendors
 */

'use client';

import { Suspense, useState, useEffect } from 'react';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, Plus, Search, RefreshCw } from 'lucide-react';
import Image from 'next/image';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { getApiErrorMessage } from '@/lib/api-error';

const iconProps = { className: 'h-5 w-5', strokeWidth: 1.5, fill: 'currentColor' as const };

const primaryNavItems = [
    { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: <LayoutDashboard {...iconProps} /> },
    { id: 'manage-deals', label: 'Manage Deals', href: '/vendor/deals', icon: <Tag {...iconProps} /> },
    { id: 'orders', label: 'Orders', href: '/vendor/orders', icon: <ShoppingBag {...iconProps} /> },
    { id: 'analytics', label: 'Analytics', href: '/vendor/analytics', icon: <BarChart3 {...iconProps} /> },
    { id: 'payment', label: 'Payment', href: '/vendor/payment', icon: <CreditCard {...iconProps} /> },
    { id: 'integration', label: 'Integration', href: '/vendor/integration', icon: <Puzzle {...iconProps} /> },
];

const secondaryNavItems = [
    { id: 'support', label: 'Support', href: '/vendor/support', icon: <LifeBuoy {...iconProps} /> },
    { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: <Settings {...iconProps} /> },
];

interface Product {
    id: string;
    name: string;
    description: string | null;
    price: number;
    student_price: number;
    category_id: string | null;
    category_name: string | null;
    image_url: string | null;
    api_id: string | null;
    stock: number;
    status: 'active' | 'inactive' | 'out_of_stock';
    deal_type?: 'product' | 'voucher';
    created_at: string;
    updated_at: string;
}

function VendorDealsContent() {
    const searchParams = useSearchParams();
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [activeTab, setActiveTab] = useState<'products' | 'vouchers'>(() =>
        searchParams.get('tab') === 'vouchers' ? 'vouchers' : 'products'
    );
    const [products, setProducts] = useState<Product[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('all');
    const [isSyncing, setIsSyncing] = useState(false);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);

    type VendorProfile = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    // Fetch products
    const fetchProducts = async () => {
        try {
            setIsLoading(true);
            const params = new URLSearchParams({
                page: page.toString(),
                limit: '20',
            });
            if (searchQuery) params.append('search', searchQuery);
            if (statusFilter !== 'all') params.append('status', statusFilter);
            params.append('deal_type', activeTab === 'vouchers' ? 'voucher' : 'product');

            const response = await apiClient.get(`/vendors/products?${params.toString()}`);
            setProducts(response.data.data.products || []);
            setTotalPages(response.data.data.pagination?.totalPages || 1);
        } catch (error: unknown) {
            console.error('Error fetching products:', error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchProducts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, statusFilter, activeTab]);

    // Debounced search — skip the initial empty query (mount already fetched)
    useEffect(() => {
        const timer = setTimeout(() => {
            if (page === 1) {
                fetchProducts();
            } else {
                setPage(1);
            }
        }, 500);

        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchQuery]);

    // Handle product sync
    const handleSync = async () => {
        try {
            setIsSyncing(true);
            await apiClient.post('/vendors/products/sync');
            // Refresh products after sync
            await fetchProducts();
            toast.success('Products synced');
        } catch (error: unknown) {
            console.error('Error syncing products:', error);
            toast.error(getApiErrorMessage(error, 'Failed to sync products'));
        } finally {
            setIsSyncing(false);
        }
    };

    // Handle delete
    const handleDelete = async (productId: string) => {
        const ok = await confirm({
            title: 'Delete product?',
            description: 'This product will be removed from your deals.',
            confirmLabel: 'Delete',
            variant: 'destructive',
        });
        if (!ok) return;

        try {
            await apiClient.delete(`/vendors/products/${productId}`);
            await fetchProducts();
            toast.success('Product deleted');
        } catch (error: unknown) {
            console.error('Error deleting product:', error);
            toast.error(getApiErrorMessage(error, 'Failed to delete product'));
        }
    };

    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case 'active':
                return 'bg-emerald-100 text-emerald-700';
            case 'inactive':
                return 'bg-slate-100 text-slate-700';
            case 'out_of_stock':
                return 'bg-rose-100 text-rose-700';
            default:
                return 'bg-slate-100 text-slate-700';
        }
    };

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Manage Deals"
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyName ?? undefined,
                    profileHref: '/vendor/settings/profile',
                    avatarUrl: null,
                }}
            >
                {/* Tabs: Products | Vouchers */}
                <div className="mb-6 border-b border-slate-200">
                    <nav className="-mb-px flex gap-6">
                        <button
                            type="button"
                            onClick={() => { setPage(1); setActiveTab('products'); }}
                            className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${activeTab === 'products'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                            }`}
                        >
                            Products
                        </button>
                        <button
                            type="button"
                            onClick={() => { setPage(1); setActiveTab('vouchers'); }}
                            className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${activeTab === 'vouchers'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                            }`}
                        >
                            Vouchers
                        </button>
                    </nav>
                </div>

                {/* Header Actions */}
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-1 items-center gap-4">
                        <div className="relative flex-1 max-w-md">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <Input
                                type="text"
                                placeholder="Search products..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-10"
                            />
                        </div>
                        <select
                            value={statusFilter}
                            onChange={(e) => {
                                setStatusFilter(e.target.value);
                                setPage(1);
                            }}
                            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                            <option value="all">All Status</option>
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                            <option value="out_of_stock">Out of Stock</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-3">
                        <Button
                            variant="outline"
                            onClick={handleSync}
                            disabled={isSyncing || activeTab === 'vouchers'}
                            className="flex items-center gap-2"
                            title={activeTab === 'vouchers' ? 'Sync applies to products only' : undefined}
                        >
                            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                            {isSyncing ? 'Syncing...' : 'Sync Products'}
                        </Button>
                        {activeTab === 'products' ? (
                            <Button asChild className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700">
                                <Link href="/vendor/deals/new">
                                    <Plus className="h-4 w-4" />
                                    Add Product
                                </Link>
                            </Button>
                        ) : (
                            <Button asChild className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700">
                                <Link href="/vendor/deals/voucher/new">
                                    <Plus className="h-4 w-4" />
                                    Add Voucher
                                </Link>
                            </Button>
                        )}
                    </div>
                </div>

                {/* Products List */}
                {isLoading ? (
                    <div className="flex items-center justify-center rounded-2xl bg-white p-12 shadow-sm">
                        <p className="text-slate-500">Loading products...</p>
                    </div>
                ) : products.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-2xl bg-white p-12 shadow-sm">
                        <Tag className="h-12 w-12 text-slate-300" />
                        <p className="mt-4 text-lg font-semibold text-slate-700">
                            {activeTab === 'vouchers' ? 'No vouchers found' : 'No products found'}
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                            {searchQuery || statusFilter !== 'all'
                                ? 'Try adjusting your filters'
                                : activeTab === 'vouchers'
                                    ? 'Create a voucher to show in the students vouchers area'
                                    : 'Get started by adding your first product'}
                        </p>
                        {!searchQuery && statusFilter === 'all' && (
                            <Button asChild className="mt-6 bg-blue-600 hover:bg-blue-700">
                                <Link href={activeTab === 'vouchers' ? '/vendor/deals/voucher/new' : '/vendor/deals/new'}>
                                    <Plus className="mr-2 h-4 w-4" />
                                    {activeTab === 'vouchers' ? 'Add Voucher' : 'Add Product'}
                                </Link>
                            </Button>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                            {products.map((product) => (
                                <div
                                    key={product.id}
                                    className="group rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                                >
                                    {product.image_url ? (
                                        <div className="relative h-48 w-full overflow-hidden rounded-t-2xl bg-slate-100">
                                            <Image
                                                src={getImageUrl(product.image_url) || ''}
                                                alt={product.name}
                                                fill
                                                className="object-cover"
                                                unoptimized
                                            />
                                        </div>
                                    ) : (
                                        <div className="flex h-48 w-full items-center justify-center rounded-t-2xl bg-slate-100">
                                            <Tag className="h-12 w-12 text-slate-300" />
                                        </div>
                                    )}
                                    <div className="p-5">
                                        <div className="mb-2 flex items-start justify-between gap-2">
                                            <h3 className="text-lg font-semibold text-slate-900 line-clamp-2">{product.name}</h3>
                                            <span
                                                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusBadgeClass(
                                                    product.status
                                                )}`}
                                            >
                                                {product.status.replace('_', ' ')}
                                            </span>
                                        </div>
                                        {product.description && (
                                            <p className="mb-3 line-clamp-2 text-sm text-slate-600">{product.description}</p>
                                        )}
                                        <div className="mb-4 flex items-center gap-3">
                                            <div>
                                                <p className="text-xs text-slate-500">Regular Price</p>
                                                <p className="text-lg font-semibold text-slate-900">
                                                    {formatCurrency(product.price)}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-slate-500">Student Price</p>
                                                <p className="text-lg font-semibold text-blue-600">
                                                    {formatCurrency(product.student_price)}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-sm text-slate-500">
                                                Stock: <span className="font-semibold text-slate-700">{product.stock}</span>
                                            </p>
                                            <div className="flex gap-2">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    asChild
                                                    className="flex-1"
                                                >
                                                    <Link href={`/vendor/deals/${product.id}/edit`}>Edit</Link>
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => handleDelete(product.id)}
                                                    className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="mt-6 flex items-center justify-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                                    disabled={page === 1}
                                >
                                    Previous
                                </Button>
                                <span className="text-sm text-slate-600">
                                    Page {page} of {totalPages}
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                    disabled={page === totalPages}
                                >
                                    Next
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </DashboardLayout>
        </ProtectedRoute>
    );
}

export default function VendorDealsPage() {
    return (
        <Suspense fallback={<div className="p-6 text-sm text-slate-600">Loading deals…</div>}>
            <VendorDealsContent />
        </Suspense>
    );
}
