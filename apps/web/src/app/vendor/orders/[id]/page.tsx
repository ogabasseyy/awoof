/**
 * Order Details Page
 * 
 * View and manage individual order details
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, ArrowLeft } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
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

interface Order {
    id: string;
    amount: number;
    commission: number;
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    paystackReference: string | null;
    createdAt: string;
    updatedAt: string;
    product: {
        id: string;
        name: string;
        description: string | null;
        imageUrl: string | null;
        price: number;
        studentPrice: number;
    };
    student: {
        id: string;
        name: string;
        email: string;
        phoneNumber: string | null;
    };
}

export default function OrderDetailsPage() {
    const router = useRouter();
    const params = useParams();
    const orderId = params.id as string;
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [order, setOrder] = useState<Order | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdating, setIsUpdating] = useState(false);

    type VendorProfile = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    useEffect(() => {
        const fetchOrder = async () => {
            try {
                setIsLoading(true);
                const response = await apiClient.get(`/vendors/orders/${orderId}`);
                setOrder(response.data.data.order);
            } catch (error: unknown) {
                console.error('Error fetching order:', error);
                toast.error(getApiErrorMessage(error, 'Failed to load order'));
                router.push('/vendor/orders');
            } finally {
                setIsLoading(false);
            }
        };

        if (orderId) {
            fetchOrder();
        }
    }, [orderId, router]);

    const handleStatusUpdate = async (newStatus: 'pending' | 'completed' | 'failed' | 'refunded') => {
        const ok = await confirm({
            title: 'Update order status?',
            description: `Change this order's status to "${newStatus}".`,
            confirmLabel: 'Update status',
        });
        if (!ok) return;

        try {
            setIsUpdating(true);
            await apiClient.put(`/vendors/orders/${orderId}/status`, { status: newStatus });

            // Refresh order data
            const response = await apiClient.get(`/vendors/orders/${orderId}`);
            setOrder(response.data.data.order);
            toast.success('Order status updated');
        } catch (error: unknown) {
            console.error('Error updating order status:', error);
            toast.error(getApiErrorMessage(error, 'Failed to update order status'));
        } finally {
            setIsUpdating(false);
        }
    };

    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case 'completed':
                return 'bg-green-100 text-green-800';
            case 'pending':
                return 'bg-yellow-100 text-yellow-800';
            case 'failed':
                return 'bg-red-100 text-red-800';
            case 'refunded':
                return 'bg-gray-100 text-gray-800';
            default:
                return 'bg-slate-100 text-slate-800';
        }
    };

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: 'NGN',
        }).format(amount);
    };

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Order Details"
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
                    <div className="flex items-center justify-center rounded-2xl bg-white p-12 shadow-sm">
                        <p className="text-slate-500">Loading order details...</p>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    if (!order) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Order Details"
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
                    <div className="flex flex-col items-center justify-center rounded-2xl bg-white p-12 shadow-sm">
                        <ShoppingBag className="h-12 w-12 text-slate-300" />
                        <p className="mt-4 text-lg font-semibold text-slate-700">Order not found</p>
                        <Button onClick={() => router.push('/vendor/orders')} className="mt-6">
                            Back to Orders
                        </Button>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Order Details"
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
                <div className="space-y-6">
                    {/* Back Button */}
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => router.back()}
                        className="mb-4 -ml-2"
                    >
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Orders
                    </Button>

                    <div className="grid gap-6 lg:grid-cols-3">
                        {/* Main Content */}
                        <div className="lg:col-span-2 space-y-6">
                            {/* Order Information */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Order Information</h2>
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-slate-600">Order ID</span>
                                        <span className="text-sm font-medium text-slate-900">{order.id.slice(0, 8)}...</span>
                                    </div>
                                    {order.paystackReference && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-slate-600">Payment Reference</span>
                                            <span className="text-sm font-medium text-slate-900">{order.paystackReference}</span>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-slate-600">Status</span>
                                        <span
                                            className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${getStatusBadgeClass(order.status)}`}
                                        >
                                            {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-slate-600">Order Date</span>
                                        <span className="text-sm font-medium text-slate-900">{formatDate(order.createdAt)}</span>
                                    </div>
                                    {order.updatedAt !== order.createdAt && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-slate-600">Last Updated</span>
                                            <span className="text-sm font-medium text-slate-900">{formatDate(order.updatedAt)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Product Information */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Product</h2>
                                <div className="flex gap-4">
                                    {order.product.imageUrl ? (
                                        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg">
                                            <Image
                                                src={getImageUrl(order.product.imageUrl) || ''}
                                                alt={order.product.name}
                                                fill
                                                className="object-cover"
                                                unoptimized
                                            />
                                        </div>
                                    ) : (
                                        <div className="flex h-24 w-24 items-center justify-center rounded-lg bg-slate-100">
                                            <Tag className="h-8 w-8 text-slate-400" />
                                        </div>
                                    )}
                                    <div className="flex-1">
                                        <h3 className="text-lg font-semibold text-slate-900">{order.product.name}</h3>
                                        {order.product.description && (
                                            <p className="mt-1 text-sm text-slate-600">{order.product.description}</p>
                                        )}
                                        <div className="mt-2 flex gap-4 text-sm">
                                            <div>
                                                <span className="text-slate-600">Regular Price: </span>
                                                <span className="font-medium text-slate-900">{formatCurrency(order.product.price)}</span>
                                            </div>
                                            <div>
                                                <span className="text-slate-600">Student Price: </span>
                                                <span className="font-medium text-blue-600">{formatCurrency(order.product.studentPrice)}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Student Information */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Student Information</h2>
                                <div className="space-y-3">
                                    <div>
                                        <span className="text-sm text-slate-600">Name</span>
                                        <p className="mt-1 text-sm font-medium text-slate-900">{order.student.name}</p>
                                    </div>
                                    <div>
                                        <span className="text-sm text-slate-600">Email</span>
                                        <p className="mt-1 text-sm font-medium text-slate-900">{order.student.email}</p>
                                    </div>
                                    {order.student.phoneNumber && (
                                        <div>
                                            <span className="text-sm text-slate-600">Phone</span>
                                            <p className="mt-1 text-sm font-medium text-slate-900">{order.student.phoneNumber}</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Sidebar */}
                        <div className="space-y-6">
                            {/* Order Summary */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Order Summary</h2>
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-slate-600">Amount</span>
                                        <span className="text-sm font-medium text-slate-900">{formatCurrency(order.amount)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-slate-600">Commission</span>
                                        <span className="text-sm font-medium text-green-600">{formatCurrency(order.commission)}</span>
                                    </div>
                                    <div className="border-t border-slate-200 pt-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-base font-semibold text-slate-900">Your Earnings</span>
                                            <span className="text-base font-bold text-slate-900">
                                                {formatCurrency(order.amount - order.commission)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Status Update */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Update Status</h2>
                                <div className="space-y-2">
                                    {(['pending', 'completed', 'failed', 'refunded'] as const).map((status) => (
                                        <Button
                                            key={status}
                                            variant={order.status === status ? 'default' : 'outline'}
                                            onClick={() => handleStatusUpdate(status)}
                                            disabled={isUpdating || order.status === status}
                                            className="w-full justify-start"
                                        >
                                            {status.charAt(0).toUpperCase() + status.slice(1)}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}

