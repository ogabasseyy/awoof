/**
 * Admin Dashboard — lively overview with live platform metrics
 */

'use client';

import { useEffect, useState } from 'react';
import {
    Users,
    ShoppingBag,
    Tag,
    BarChart3,
    GraduationCap,
    ArrowRight,
    Sparkles,
    LayoutGrid,
    Shield,
    Clock,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import Link from 'next/link';
import apiClient from '@/lib/api-client';
import { formatCurrency } from '@/lib/format';
import { FadeIn } from '@/app/marketplace/_components/ExpectancyUI';
import { primaryNavItems, secondaryNavItems } from '../adminNav';

interface DashboardMetrics {
    totalStudents: number;
    totalVendors: number;
    totalProducts: number;
    totalRevenue: number;
    totalCommission: number;
    completedOrders: number;
    totalUniversities: number;
    pendingVendors: number;
    openTickets: number;
    ordersLast30: number;
}

export default function AdminDashboardPage() {
    const { user, logout } = useAuth();
    const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiClient.get('/admin/analytics');
                const data = res.data?.data;
                if (!cancelled && data) {
                    setMetrics({
                        totalStudents: data.counts?.totalStudents ?? 0,
                        totalVendors: data.counts?.totalVendors ?? 0,
                        totalProducts: data.counts?.totalProducts ?? 0,
                        totalRevenue: data.transactions?.totalRevenue ?? 0,
                        totalCommission: data.transactions?.totalCommission ?? 0,
                        completedOrders: data.transactions?.completedOrders ?? 0,
                        totalUniversities: data.counts?.totalUniversities ?? 0,
                        pendingVendors: data.vendorsByStatus?.pending ?? 0,
                        openTickets: data.support?.openTickets ?? 0,
                        ordersLast30: data.last30Days?.orders ?? 0,
                    });
                }
            } catch {
                if (!cancelled) setMetrics(null);
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

    const displayName =
        (user as User & { profile?: { name?: string } })?.profile?.name ||
        user?.email?.split('@')[0] ||
        'Admin';
    const firstName = displayName.split(' ')[0];

    const isQuiet =
        !metrics ||
        (metrics.totalStudents === 0 &&
            metrics.totalVendors === 0 &&
            metrics.totalProducts === 0 &&
            metrics.totalRevenue === 0 &&
            metrics.completedOrders === 0);

    const quickActions = [
        {
            href: '/admin/vendors',
            title: 'Review vendors',
            body: metrics?.pendingVendors
                ? `${metrics.pendingVendors} awaiting approval`
                : 'Approve partners to go live',
            icon: ShoppingBag,
            accent: 'bg-[#EEF2FF] text-[#1D4ED8]',
        },
        {
            href: '/admin/universities',
            title: 'Universities',
            body: 'Campus catalog & email domains',
            icon: GraduationCap,
            accent: 'bg-sky-50 text-sky-700',
        },
        {
            href: '/admin/students',
            title: 'Students',
            body: 'Verified users & spend',
            icon: Users,
            accent: 'bg-emerald-50 text-emerald-700',
        },
        {
            href: '/admin/categories',
            title: 'Categories',
            body: 'Deal taxonomy for the marketplace',
            icon: Tag,
            accent: 'bg-amber-50 text-amber-800',
        },
    ];

    const statCards = [
        {
            label: 'Students',
            value: isLoading ? '…' : (metrics?.totalStudents ?? 0).toLocaleString(),
            hint: isQuiet ? 'Grows as students verify' : 'Registered student accounts',
            icon: Users,
            tint: 'from-[#EEF2FF] to-white',
        },
        {
            label: 'Vendors',
            value: isLoading ? '…' : (metrics?.totalVendors ?? 0).toLocaleString(),
            hint:
                metrics?.pendingVendors && metrics.pendingVendors > 0
                    ? `${metrics.pendingVendors} pending approval`
                    : isQuiet
                      ? 'Partners waiting to onboard'
                      : 'Active merchant accounts',
            icon: ShoppingBag,
            tint: 'from-emerald-50 to-white',
        },
        {
            label: 'Revenue',
            value: isLoading ? '…' : formatCurrency(metrics?.totalRevenue ?? 0),
            hint: isQuiet
                ? 'Completed sales volume'
                : `${(metrics?.completedOrders ?? 0).toLocaleString()} completed order${(metrics?.completedOrders ?? 0) === 1 ? '' : 's'}`,
            icon: BarChart3,
            tint: 'from-sky-50 to-white',
        },
        {
            label: 'Commission',
            value: isLoading ? '…' : formatCurrency(metrics?.totalCommission ?? 0),
            hint: isQuiet ? 'Platform fee on completed sales' : 'Awoof take from completed sales',
            icon: Tag,
            tint: 'from-violet-50 to-white',
        },
    ];

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle=""
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Admin',
                    profileHref: '/admin/settings',
                }}
                onLogout={handleLogout}
                logoutLabel="Logout"
            >
                <div className="space-y-6">
                    <FadeIn>
                        <section className="relative overflow-hidden rounded-3xl bg-[#1D4ED8] px-6 py-8 text-white shadow-xl shadow-[#1D4ED8]/20 md:px-8 md:py-9">
                            <div
                                aria-hidden
                                className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-white/10 blur-2xl"
                            />
                            <div
                                aria-hidden
                                className="absolute -bottom-16 left-1/3 h-40 w-40 rounded-full bg-sky-300/20 blur-3xl"
                            />
                            <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                                <div className="max-w-xl space-y-2">
                                    <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-blue-100">
                                        <Shield className="h-3.5 w-3.5" />
                                        Platform control
                                    </p>
                                    <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl text-balance">
                                        Hey {firstName}, here’s the pulse
                                    </h1>
                                    <p className="text-sm text-blue-100/95 leading-relaxed text-pretty md:text-[15px]">
                                        {isQuiet
                                            ? 'The platform is ready. Approve vendors, seed universities, and watch the marketplace fill up.'
                                            : 'Students, vendors, and revenue at a glance — dive into analytics for the full story.'}
                                    </p>
                                </div>
                                <Link
                                    href="/admin/analytics"
                                    className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-[#1D4ED8] hover:bg-blue-50 transition-colors"
                                >
                                    Open analytics
                                    <ArrowRight className="h-4 w-4" />
                                </Link>
                            </div>
                        </section>
                    </FadeIn>

                    <FadeIn delay={0.05}>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {quickActions.map((action) => {
                                const Icon = action.icon;
                                return (
                                    <Link
                                        key={action.href}
                                        href={action.href}
                                        className="group rounded-2xl border border-slate-200/80 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-[#1D4ED8]/25 hover:shadow-md"
                                    >
                                        <span
                                            className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl ${action.accent}`}
                                        >
                                            <Icon className="h-5 w-5" />
                                        </span>
                                        <p className="font-bold text-slate-900">{action.title}</p>
                                        <p className="mt-1 text-xs text-slate-500 leading-snug">{action.body}</p>
                                        <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#1D4ED8] opacity-0 transition-opacity group-hover:opacity-100">
                                            Open <ArrowRight className="h-3.5 w-3.5" />
                                        </span>
                                    </Link>
                                );
                            })}
                        </div>
                    </FadeIn>

                    <FadeIn delay={0.08}>
                        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            {statCards.map((stat) => {
                                const Icon = stat.icon;
                                return (
                                    <div
                                        key={stat.label}
                                        className={`relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br ${stat.tint} p-5`}
                                    >
                                        <div className="flex items-start justify-between">
                                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                                {stat.label}
                                            </p>
                                            <span className="rounded-lg bg-white/80 p-2 text-[#1D4ED8] shadow-sm">
                                                <Icon className="h-4 w-4" />
                                            </span>
                                        </div>
                                        <p className="mt-3 text-3xl font-extrabold tracking-tight text-slate-900">
                                            {stat.value}
                                        </p>
                                        <p className="mt-2 text-xs text-slate-500">{stat.hint}</p>
                                    </div>
                                );
                            })}
                        </section>
                    </FadeIn>

                    <FadeIn delay={0.12}>
                        <section className="grid gap-4 lg:grid-cols-2">
                            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 md:p-6">
                                <div className="mb-5 flex items-center justify-between">
                                    <div>
                                        <p className="font-bold text-slate-900">Platform snapshot</p>
                                        <p className="text-xs text-slate-500 mt-0.5">Operational highlights</p>
                                    </div>
                                    <LayoutGrid className="h-5 w-5 text-slate-300" />
                                </div>
                                <div className="space-y-3">
                                    {[
                                        {
                                            label: 'Products listed',
                                            value: isLoading
                                                ? '…'
                                                : (metrics?.totalProducts ?? 0).toLocaleString(),
                                            icon: Tag,
                                        },
                                        {
                                            label: 'Universities seeded',
                                            value: isLoading
                                                ? '…'
                                                : (metrics?.totalUniversities ?? 0).toLocaleString(),
                                            icon: GraduationCap,
                                        },
                                        {
                                            label: 'Orders (last 30 days)',
                                            value: isLoading
                                                ? '…'
                                                : (metrics?.ordersLast30 ?? 0).toLocaleString(),
                                            icon: BarChart3,
                                        },
                                        {
                                            label: 'Open support tickets',
                                            value: isLoading
                                                ? '…'
                                                : (metrics?.openTickets ?? 0).toLocaleString(),
                                            icon: Clock,
                                        },
                                    ].map((row) => {
                                        const Icon = row.icon;
                                        return (
                                            <div
                                                key={row.label}
                                                className="flex items-center justify-between rounded-xl bg-slate-50/80 px-4 py-3"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-[#1D4ED8] shadow-sm">
                                                        <Icon className="h-4 w-4" />
                                                    </span>
                                                    <span className="text-sm font-medium text-slate-700">
                                                        {row.label}
                                                    </span>
                                                </div>
                                                <span className="text-sm font-extrabold text-slate-900">
                                                    {row.value}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 md:p-6">
                                <div className="mb-5 flex items-center justify-between">
                                    <div>
                                        <p className="font-bold text-slate-900">Recent activity</p>
                                        <p className="text-xs text-slate-500 mt-0.5">What needs your attention</p>
                                    </div>
                                    <Sparkles className="h-5 w-5 text-slate-300" />
                                </div>
                                {isQuiet || (metrics?.pendingVendors === 0 && metrics?.openTickets === 0) ? (
                                    <div className="flex h-[calc(100%-3rem)] min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#1D4ED8]/25 bg-gradient-to-br from-[#F8FAFF] to-[#EEF4FF] px-6 text-center">
                                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#1D4ED8] text-white shadow-lg shadow-[#1D4ED8]/25">
                                            <Sparkles className="h-6 w-6" />
                                        </div>
                                        <p className="font-bold text-slate-900">All quiet on the platform</p>
                                        <p className="mt-1 max-w-sm text-sm text-slate-500 leading-relaxed">
                                            New vendor applications and support tickets will surface here when they
                                            arrive.
                                        </p>
                                        <Link
                                            href="/admin/vendors"
                                            className="mt-4 text-sm font-bold text-[#1D4ED8] hover:underline"
                                        >
                                            Check vendor queue →
                                        </Link>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {(metrics?.pendingVendors ?? 0) > 0 && (
                                            <Link
                                                href="/admin/vendors"
                                                className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100/80"
                                            >
                                                <div>
                                                    <p className="text-sm font-bold text-amber-900">
                                                        {metrics!.pendingVendors} vendor
                                                        {metrics!.pendingVendors === 1 ? '' : 's'} pending
                                                    </p>
                                                    <p className="text-xs text-amber-800/80">
                                                        Review and approve to go live
                                                    </p>
                                                </div>
                                                <ArrowRight className="h-4 w-4 text-amber-700" />
                                            </Link>
                                        )}
                                        {(metrics?.openTickets ?? 0) > 0 && (
                                            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                                <div>
                                                    <p className="text-sm font-bold text-slate-900">
                                                        {metrics!.openTickets} open support ticket
                                                        {metrics!.openTickets === 1 ? '' : 's'}
                                                    </p>
                                                    <p className="text-xs text-slate-500">
                                                        From students and vendors
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                        <Link
                                            href="/admin/analytics"
                                            className="inline-flex items-center gap-1 text-sm font-semibold text-[#1D4ED8] hover:underline"
                                        >
                                            Full analytics <ArrowRight className="h-3.5 w-3.5" />
                                        </Link>
                                    </div>
                                )}
                            </div>
                        </section>
                    </FadeIn>
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
