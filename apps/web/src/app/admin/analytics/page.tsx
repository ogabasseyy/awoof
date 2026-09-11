/**
 * Admin Analytics
 *
 * Platform-wide metrics with info tooltips explaining each metric and data source.
 */

'use client';

import { useState, useEffect } from 'react';
import {
    Users,
    ShoppingBag,
    Tag,
    GraduationCap,
    LayoutGrid,
    BarChart3,
    CreditCard,
    Percent,
    Heart,
    MessageCircle,
    TrendingUp,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import { formatCurrency, formatSavings } from '@/lib/format';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { primaryNavItems, secondaryNavItems } from '../adminNav';

interface AnalyticsData {
    counts: {
        totalStudents: number;
        totalVendors: number;
        totalProducts: number;
        totalCategories: number;
        totalUniversities: number;
    };
    transactions: {
        totalOrders: number;
        completedOrders: number;
        totalRevenue: number;
        totalCommission: number;
        conversionRate: number;
    };
    studentImpact: {
        totalStudentSavings: number | null;
        recordedSavings?: number;
    };
    support: {
        openTickets: number;
    };
    vendorsByStatus: Record<string, number>;
    last30Days: {
        orders: number;
        revenue: number;
    };
}

function MetricCard({
    label,
    value,
    icon: Icon,
    iconBg,
    iconColor,
    tooltipTitle,
    tooltipDescription,
}: {
    label: string;
    value: string | number;
    icon: React.ElementType;
    iconBg: string;
    iconColor: string;
    tooltipTitle: string;
    tooltipDescription: string;
}) {
    return (
        <div className="rounded-lg bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-slate-600">{label}</p>
                        <InfoTooltip title={tooltipTitle} description={tooltipDescription} />
                    </div>
                    <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
                </div>
                <div className={`rounded-full p-3 ${iconBg}`}>
                    <Icon className={`h-6 w-6 ${iconColor}`} />
                </div>
            </div>
        </div>
    );
}

export default function AdminAnalyticsPage() {
    const { user, logout } = useAuth();
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setIsLoading(true);
                setError(null);
                const res = await apiClient.get('/admin/analytics');
                if (!cancelled) setData(res.data.data ?? null);
            } catch (e) {
                if (!cancelled) {
                    setError('Failed to load analytics');
                    setData(null);
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleLogout = async () => {
        await logout();
    };

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="admin">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Analytics"
                    user={user as User}
                    onLogout={handleLogout}
                    logoutLabel="Logout"
                >
                    <div className="py-12 text-center text-slate-500">Loading analytics...</div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    if (error || !data) {
        return (
            <ProtectedRoute requiredRole="admin">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Analytics"
                    user={user as User}
                    onLogout={handleLogout}
                    logoutLabel="Logout"
                >
                    <div className="rounded-lg bg-white p-12 text-center shadow-sm">
                        <BarChart3 className="mx-auto h-12 w-12 text-slate-400" />
                        <p className="mt-4 text-slate-600">{error ?? 'No data'}</p>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    const { counts, transactions, studentImpact, support, vendorsByStatus, last30Days } = data;

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Analytics"
                user={user as User}
                onLogout={handleLogout}
                logoutLabel="Logout"
            >
                <div className="space-y-8">
                    <section>
                        <h2 className="mb-4 text-lg font-semibold text-slate-900">Platform overview</h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                            <MetricCard
                                label="Total Students"
                                value={counts.totalStudents.toLocaleString()}
                                icon={Users}
                                iconBg="bg-blue-100"
                                iconColor="text-blue-600"
                                tooltipTitle="Total Students"
                                tooltipDescription="Count of all registered students (students table joined with users). Excludes soft-deleted users and students with status 'deleted'. Used to track platform adoption."
                            />
                            <MetricCard
                                label="Total Vendors"
                                value={counts.totalVendors.toLocaleString()}
                                icon={ShoppingBag}
                                iconBg="bg-green-100"
                                iconColor="text-green-600"
                                tooltipTitle="Total Vendors"
                                tooltipDescription="Count of all vendor accounts that are not soft-deleted (vendors table, deleted_at IS NULL). Includes pending, active, and suspended vendors."
                            />
                            <MetricCard
                                label="Total Products"
                                value={counts.totalProducts.toLocaleString()}
                                icon={Tag}
                                iconBg="bg-purple-100"
                                iconColor="text-purple-600"
                                tooltipTitle="Total Products"
                                tooltipDescription="Count of all product listings that are not soft-deleted (products table, deleted_at IS NULL). Includes active, inactive, and out-of-stock products."
                            />
                            <MetricCard
                                label="Categories"
                                value={counts.totalCategories.toLocaleString()}
                                icon={LayoutGrid}
                                iconBg="bg-slate-100"
                                iconColor="text-slate-600"
                                tooltipTitle="Categories"
                                tooltipDescription="Total number of product categories in the system (categories table). Used to organize the marketplace."
                            />
                            <MetricCard
                                label="Universities"
                                value={counts.totalUniversities.toLocaleString()}
                                icon={GraduationCap}
                                iconBg="bg-amber-100"
                                iconColor="text-amber-600"
                                tooltipTitle="Universities"
                                tooltipDescription="Total number of universities in the directory (universities table). Used for student verification and segmentation."
                            />
                        </div>
                    </section>

                    <section>
                        <h2 className="mb-4 text-lg font-semibold text-slate-900">Transactions & revenue</h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                            <MetricCard
                                label="Total Orders"
                                value={transactions.totalOrders.toLocaleString()}
                                icon={BarChart3}
                                iconBg="bg-slate-100"
                                iconColor="text-slate-600"
                                tooltipTitle="Total Orders"
                                tooltipDescription="Total number of transactions (orders) ever created on the platform (transactions table). Includes pending, completed, failed, and refunded. Reflects overall marketplace activity."
                            />
                            <MetricCard
                                label="Completed Orders"
                                value={transactions.completedOrders.toLocaleString()}
                                icon={BarChart3}
                                iconBg="bg-emerald-100"
                                iconColor="text-emerald-600"
                                tooltipTitle="Completed Orders"
                                tooltipDescription="Number of transactions with status 'completed' (transactions table). Only these orders count toward revenue and commission. Failed or refunded orders are excluded."
                            />
                            <MetricCard
                                label="Total Revenue (GMV)"
                                value={formatCurrency(transactions.totalRevenue)}
                                icon={CreditCard}
                                iconBg="bg-blue-100"
                                iconColor="text-blue-600"
                                tooltipTitle="Total Revenue (GMV)"
                                tooltipDescription="Gross Merchandise Value: sum of the 'amount' field for all completed transactions. This is the total value of successful student purchases flowing through the platform (transactions table, status = 'completed')."
                            />
                            <MetricCard
                                label="Platform Commission"
                                value={formatCurrency(transactions.totalCommission)}
                                icon={CreditCard}
                                iconBg="bg-orange-100"
                                iconColor="text-orange-600"
                                tooltipTitle="Platform Commission"
                                tooltipDescription="Awoof's share of completed transactions. Sum of the 'commission' field for all completed transactions (transactions table, status = 'completed'). This is the platform's revenue from payment splits."
                            />
                            <MetricCard
                                label="Conversion Rate"
                                value={`${transactions.conversionRate.toFixed(1)}%`}
                                icon={Percent}
                                iconBg="bg-violet-100"
                                iconColor="text-violet-600"
                                tooltipTitle="Conversion Rate"
                                tooltipDescription="Percentage of all orders that reached 'completed' status. Formula: (completed orders ÷ total orders) × 100. Indicates how many initiated orders result in successful payment."
                            />
                        </div>
                    </section>

                    <section>
                        <h2 className="mb-4 text-lg font-semibold text-slate-900">Student impact & support</h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <MetricCard
                                label="Total Student Savings"
                                value={formatSavings(studentImpact.totalStudentSavings, studentImpact.recordedSavings)}
                                icon={Heart}
                                iconBg="bg-rose-100"
                                iconColor="text-rose-600"
                                tooltipTitle="Total Student Savings"
                                tooltipDescription="Savings recorded when completed purchases were settled. Partial totals exclude purchases whose historical savings are unknown."
                            />
                            <MetricCard
                                label="Open Support Tickets"
                                value={support.openTickets.toLocaleString()}
                                icon={MessageCircle}
                                iconBg="bg-amber-100"
                                iconColor="text-amber-600"
                                tooltipTitle="Open Support Tickets"
                                tooltipDescription="Number of support tickets with status 'open' or 'in-progress' (support_tickets table). Excludes resolved and closed. Use this to prioritize customer support workload."
                            />
                        </div>
                    </section>

                    <section>
                        <h2 className="mb-4 text-lg font-semibold text-slate-900">Vendor status & recent activity</h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Vendors (Active)"
                                value={(vendorsByStatus.active ?? 0).toLocaleString()}
                                icon={ShoppingBag}
                                iconBg="bg-green-100"
                                iconColor="text-green-600"
                                tooltipTitle="Active Vendors"
                                tooltipDescription="Vendors with status 'active' (vendors table). These accounts can list products and receive orders. Excludes soft-deleted rows."
                            />
                            <MetricCard
                                label="Vendors (Pending)"
                                value={(vendorsByStatus.pending ?? 0).toLocaleString()}
                                icon={ShoppingBag}
                                iconBg="bg-slate-100"
                                iconColor="text-slate-600"
                                tooltipTitle="Pending Vendors"
                                tooltipDescription="Vendors with status 'pending' (vendors table). Awaiting approval before they can go live. Excludes soft-deleted rows."
                            />
                            <MetricCard
                                label="Vendors (Suspended)"
                                value={(vendorsByStatus.suspended ?? 0).toLocaleString()}
                                icon={ShoppingBag}
                                iconBg="bg-red-100"
                                iconColor="text-red-600"
                                tooltipTitle="Suspended Vendors"
                                tooltipDescription="Vendors with status 'suspended' (vendors table). Temporarily disabled from selling. Excludes soft-deleted rows."
                            />
                            <MetricCard
                                label="Orders (Last 30 days)"
                                value={last30Days.orders.toLocaleString()}
                                icon={TrendingUp}
                                iconBg="bg-blue-100"
                                iconColor="text-blue-600"
                                tooltipTitle="Orders in Last 30 Days"
                                tooltipDescription="Total number of transactions created in the past 30 days (transactions.created_at). Includes all statuses. Gives a short-term trend of marketplace activity."
                            />
                            <MetricCard
                                label="Revenue (Last 30 days)"
                                value={formatCurrency(last30Days.revenue)}
                                icon={TrendingUp}
                                iconBg="bg-emerald-100"
                                iconColor="text-emerald-600"
                                tooltipTitle="Revenue in Last 30 Days"
                                tooltipDescription="Sum of transaction amount for completed orders in the past 30 days (transactions table, status = 'completed', created_at >= 30 days ago). Short-term GMV trend."
                            />
                        </div>
                    </section>
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
