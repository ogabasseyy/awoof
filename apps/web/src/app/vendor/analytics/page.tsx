/**
 * Vendor Analytics Page
 * 
 * Analytics and reporting interface for vendors
 */

'use client';

import React, { useState, useEffect } from 'react';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, TrendingUp, DollarSign, Users, Package } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
import { formatCurrency } from '@/lib/format';
import { parseVendorStudentAnalytics } from '@/lib/vendor-analytics';

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

interface OverallMetrics {
    totalOrders: number;
    completedOrders: number;
    totalRevenue: number;
    totalCommission: number;
    totalEarnings: number;
    uniqueCustomers: number;
    averageOrderValue: number;
    conversionRate: number;
}

interface ProductAnalytic {
    id: string;
    name: string;
    price: number;
    studentPrice: number;
    status: string;
    totalOrders: number;
    completedOrders: number;
    revenue: number;
    commission: number;
    earnings: number;
    uniqueCustomers: number;
}

interface TimeBasedData {
    date: string;
    orders: number;
    completedOrders: number;
    revenue: number;
    uniqueCustomers: number;
}

interface MonthlyData {
    month: string;
    orders: number;
    completedOrders: number;
    revenue: number;
    commission: number;
    earnings: number;
    uniqueCustomers: number;
}

interface StudentAnalytics {
    totalStudents: number;
    purchasingStudents: number;
    /** @deprecated Server alias; the parser falls back to it on mixed-version responses. */
    verifiedStudents?: number;
    repeatCustomers: number;
}

interface TopProduct {
    id: string;
    name: string;
    imageUrl: string | null;
    orders: number;
    revenue: number;
}

interface AnalyticsData {
    overall: OverallMetrics;
    products: ProductAnalytic[];
    timeBased: TimeBasedData[];
    monthly: MonthlyData[];
    students: StudentAnalytics;
    topProducts: TopProduct[];
}


function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
}

function formatMonth(dateString: string): string {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
    });
}

export default function VendorAnalyticsPage() {
    const { user, logout } = useAuth();
    const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'overview' | 'products' | 'students'>('overview');

    useEffect(() => {
        fetchAnalytics();
    }, []);

    const fetchAnalytics = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get('/vendors/analytics');
            setAnalytics(response.data.data);
        } catch (error: unknown) {
            console.error('Error fetching analytics:', error);
        } finally {
            setIsLoading(false);
        }
    };

    if (!user) {
        return null;
    }

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Analytics"
                    onLogout={logout}
                    logoutLabel="Logout"
                    user={{
                        name: user?.email?.split('@')[0] ?? null,
                        email: user?.email ?? null,
                        roleLabel: 'Vendor',
                    }}
                >
                    <div className="flex h-64 items-center justify-center">
                        <div className="text-slate-500">Loading analytics...</div>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    if (!analytics) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Analytics"
                    onLogout={logout}
                    logoutLabel="Logout"
                    user={{
                        name: user?.email?.split('@')[0] ?? null,
                        email: user?.email ?? null,
                        roleLabel: 'Vendor',
                    }}
                >
                    <div className="flex h-64 items-center justify-center">
                        <div className="text-slate-500">No analytics data available</div>
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
                pageTitle="Analytics"
                onLogout={logout}
                logoutLabel="Logout"
                user={{
                    name: user?.email?.split('@')[0] ?? null,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                }}
            >
                <div className="space-y-6">
                    {/* Page Description */}
                    <div>
                        <p className="text-sm text-slate-600">
                            Track your performance, sales, and customer insights
                        </p>
                    </div>

                    {/* Overall Metrics Cards */}
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-600">Total Revenue</p>
                                    <p className="mt-2 text-2xl font-bold text-slate-900">
                                        {formatCurrency(analytics.overall.totalRevenue)}
                                    </p>
                                </div>
                                <div className="rounded-full bg-blue-100 p-3">
                                    <DollarSign className="h-6 w-6 text-blue-600" />
                                </div>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-600">Total Orders</p>
                                    <p className="mt-2 text-2xl font-bold text-slate-900">
                                        {analytics.overall.totalOrders}
                                    </p>
                                    <p className="mt-1 text-xs text-slate-500">
                                        {analytics.overall.completedOrders} completed
                                    </p>
                                </div>
                                <div className="rounded-full bg-purple-100 p-3">
                                    <ShoppingBag className="h-6 w-6 text-purple-600" />
                                </div>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-600">Unique Customers</p>
                                    <p className="mt-2 text-2xl font-bold text-slate-900">
                                        {analytics.overall.uniqueCustomers}
                                    </p>
                                </div>
                                <div className="rounded-full bg-green-100 p-3">
                                    <Users className="h-6 w-6 text-green-600" />
                                </div>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-600">Conversion Rate</p>
                                    <p className="mt-2 text-2xl font-bold text-slate-900">
                                        {analytics.overall.conversionRate.toFixed(1)}%
                                    </p>
                                    <p className="mt-1 text-xs text-slate-500">
                                        Avg order: {formatCurrency(analytics.overall.averageOrderValue)}
                                    </p>
                                </div>
                                <div className="rounded-full bg-orange-100 p-3">
                                    <TrendingUp className="h-6 w-6 text-orange-600" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="border-b border-slate-200">
                        <nav className="-mb-px flex space-x-8">
                            <button
                                onClick={() => setActiveTab('overview')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'overview'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Overview
                            </button>
                            <button
                                onClick={() => setActiveTab('products')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'products'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Products
                            </button>
                            <button
                                onClick={() => setActiveTab('students')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'students'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Students
                            </button>
                        </nav>
                    </div>

                    {/* Overview Tab */}
                    {activeTab === 'overview' && (
                        <div className="space-y-6">
                            {/* Revenue Chart (Simple Bar Chart) */}
                            {analytics.timeBased.length > 0 && (
                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <h2 className="mb-4 text-lg font-semibold text-slate-900">Revenue Trend (Last 30 Days)</h2>
                                    <div className="h-64">
                                        <div className="flex h-full items-end justify-between gap-2">
                                            {analytics.timeBased.map((data) => {
                                                const maxRevenue = Math.max(...analytics.timeBased.map((d) => d.revenue));
                                                const height = maxRevenue > 0 ? (data.revenue / maxRevenue) * 100 : 0;
                                                return (
                                                    <div key={data.date} className="flex flex-1 flex-col items-center gap-1">
                                                        <div className="relative w-full">
                                                            <div
                                                                className="w-full rounded-t bg-blue-500 transition-all"
                                                                style={{ height: `${height}%`, minHeight: height > 0 ? '4px' : '0' }}
                                                                title={`${formatDate(data.date)}: ${formatCurrency(data.revenue)}`}
                                                            />
                                                        </div>
                                                        <span className="mt-2 text-xs text-slate-500">
                                                            {formatDate(data.date)}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Monthly Summary */}
                            {analytics.monthly.length > 0 && (
                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <h2 className="mb-4 text-lg font-semibold text-slate-900">Monthly Summary</h2>
                                    <div className="overflow-x-auto">
                                        <table className="w-full">
                                            <thead className="bg-slate-50">
                                                <tr>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Month
                                                    </th>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Orders
                                                    </th>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Revenue
                                                    </th>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Commission
                                                    </th>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Earnings
                                                    </th>
                                                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                        Customers
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-200 bg-white">
                                                {analytics.monthly.map((item) => (
                                                    <tr key={item.month}>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-slate-900">
                                                            {formatMonth(item.month)}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                            {item.orders}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                            {formatCurrency(item.revenue)}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">
                                                            {formatCurrency(item.commission)}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-green-600">
                                                            {formatCurrency(item.earnings)}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                            {item.uniqueCustomers}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {/* Top Products */}
                            {analytics.topProducts.length > 0 && (
                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <h2 className="mb-4 text-lg font-semibold text-slate-900">Top Products by Revenue</h2>
                                    <div className="space-y-4">
                                        {analytics.topProducts.map((product, index) => {
                                            const imageUrl = product.imageUrl;
                                            return (
                                                <div key={product.id} className="flex items-center gap-4 rounded-lg border border-slate-200 p-4">
                                                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 text-lg font-bold text-slate-600">
                                                        #{index + 1}
                                                    </div>
                                                    {imageUrl ? (() => {
                                                        const url = getImageUrl(imageUrl);
                                                        return url ? (
                                                            <div className="relative h-12 w-12 overflow-hidden rounded-lg">
                                                                <Image
                                                                    src={url}
                                                                    alt={product.name}
                                                                    fill
                                                                    className="object-cover"
                                                                    unoptimized
                                                                />
                                                            </div>
                                                        ) : null;
                                                    })() : null}
                                                    <div className="flex-1">
                                                        <p className="font-medium text-slate-900">{product.name}</p>
                                                        <p className="text-sm text-slate-500">
                                                            {product.orders} orders
                                                        </p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-semibold text-slate-900">
                                                            {formatCurrency(product.revenue)}
                                                        </p>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Products Tab */}
                    {activeTab === 'products' && (
                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <h2 className="mb-4 text-lg font-semibold text-slate-900">Product Performance</h2>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-slate-50">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Product
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Status
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Orders
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Revenue
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Commission
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Earnings
                                            </th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-700">
                                                Customers
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200 bg-white">
                                        {analytics.products.map((product) => (
                                            <tr key={product.id}>
                                                <td className="px-4 py-3">
                                                    <div>
                                                        <p className="font-medium text-slate-900">{product.name}</p>
                                                        <p className="text-xs text-slate-500">
                                                            {formatCurrency(product.studentPrice)}
                                                        </p>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    <span
                                                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${product.status === 'active'
                                                            ? 'bg-green-100 text-green-800'
                                                            : 'bg-slate-100 text-slate-800'
                                                            }`}
                                                    >
                                                        {product.status}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                    {product.totalOrders}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                    {formatCurrency(product.revenue)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600">
                                                    {formatCurrency(product.commission)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-green-600">
                                                    {formatCurrency(product.earnings)}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-900">
                                                    {product.uniqueCustomers}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Students Tab */}
                    {activeTab === 'students' && (
                        <div className="space-y-6">
                            <div className="grid gap-4 md:grid-cols-3">
                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-medium text-slate-600">Total Students</p>
                                            <p className="mt-2 text-2xl font-bold text-slate-900">
                                                {analytics.students.totalStudents}
                                            </p>
                                        </div>
                                        <div className="rounded-full bg-blue-100 p-3">
                                            <Users className="h-6 w-6 text-blue-600" />
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-medium text-slate-600">Purchasing Students</p>
                                            <p className="mt-2 text-2xl font-bold text-green-600">
                                                {parseVendorStudentAnalytics(analytics.students)?.purchasingStudents ?? '—'}
                                            </p>
                                        </div>
                                        <div className="rounded-full bg-green-100 p-3">
                                            <Package className="h-6 w-6 text-green-600" />
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-medium text-slate-600">Repeat Customers</p>
                                            <p className="mt-2 text-2xl font-bold text-purple-600">
                                                {analytics.students.repeatCustomers}
                                            </p>
                                        </div>
                                        <div className="rounded-full bg-purple-100 p-3">
                                            <TrendingUp className="h-6 w-6 text-purple-600" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}

