/**
 * Vendor Dashboard — live purchase / commission overview
 */

'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
    BarChart3,
    CreditCard,
    LayoutDashboard,
    LifeBuoy,
    Puzzle,
    Settings,
    ShoppingBag,
    Tag,
    Plus,
    ArrowRight,
    Sparkles,
    TrendingUp,
    Wallet,
    Percent,
    TicketPercent,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import { FadeIn } from '@/app/marketplace/_components/ExpectancyUI';
import apiClient from '@/lib/api-client';
import { formatCurrency } from '@/lib/format';

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

interface TimeBasedPoint {
    date: string;
    orders: number;
    completedOrders: number;
    revenue: number;
}

interface TopProduct {
    id: string;
    name: string;
    orders: number;
    revenue: number;
}

interface RecentOrder {
    id: string;
    amount: number;
    commission: number;
    status: string;
    createdAt: string;
    product: { id: string; name: string };
    student: { id: string; name: string; email: string };
}

function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function statusTone(status: string): string {
    if (status === 'completed') return 'bg-emerald-100 text-emerald-700';
    if (status === 'failed' || status === 'refunded') return 'bg-rose-100 text-rose-700';
    return 'bg-amber-100 text-amber-800';
}

function VendorDashboardContent() {
    const { user, refreshUser, logout } = useAuth();
    const searchParams = useSearchParams();
    const [overall, setOverall] = useState<OverallMetrics | null>(null);
    const [timeBased, setTimeBased] = useState<TimeBasedPoint[]>([]);
    const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
    const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const verified = searchParams.get('verified');
        if (verified !== 'true') return;
        let cancelled = false;
        (async () => {
            await refreshUser();
            if (!cancelled && typeof window !== 'undefined') {
                window.history.replaceState({}, '', '/vendor/dashboard');
            }
        })();
        return () => {
            cancelled = true;
        };
        // refreshUser is stable (useCallback); only react to searchParams
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [analyticsSettled, ordersSettled] = await Promise.allSettled([
                    apiClient.get('/vendors/analytics'),
                    apiClient.get('/vendors/orders?page=1&limit=5'),
                ]);
                if (cancelled) return;

                if (analyticsSettled.status === 'fulfilled') {
                    const data = analyticsSettled.value.data?.data;
                    if (data?.overall) setOverall(data.overall);
                    if (Array.isArray(data?.timeBased)) setTimeBased(data.timeBased);
                    if (Array.isArray(data?.topProducts)) setTopProducts(data.topProducts.slice(0, 4));
                }

                if (ordersSettled.status === 'fulfilled') {
                    setRecentOrders(ordersSettled.value.data?.data?.orders ?? []);
                }
            } catch {
                // Individual request failures handled above
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const isVerified = user?.verificationStatus === 'verified';
    type VendorProfile = { companyName?: string | null; name?: string | null; status?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';
    const firstName = (extendedUser?.profile?.name || companyName || 'there').split(' ')[0];

    const completedOrders = overall?.completedOrders ?? 0;
    const isQuiet = !isLoading && completedOrders === 0;

    const last7 = (() => {
        const byDay = new Map<string, TimeBasedPoint>();
        for (const point of timeBased) {
            const key = new Date(point.date).toISOString().slice(0, 10);
            byDay.set(key, point);
        }
        const days: { label: string; orders: number; revenue: number }[] = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            const point = byDay.get(key);
            days.push({
                label: d.toLocaleDateString(undefined, { weekday: 'short' }),
                orders: point?.completedOrders ?? point?.orders ?? 0,
                revenue: point?.revenue ?? 0,
            });
        }
        return days;
    })();
    const maxChart = Math.max(1, ...last7.map((d) => d.orders));

    const quickActions = [
        {
            href: '/vendor/deals/new',
            title: 'Create a deal',
            body: 'Launch a student-only offer in minutes',
            icon: Plus,
            accent: 'bg-[#1D4ED8] text-white',
        },
        {
            href: '/vendor/deals/voucher/new',
            title: 'Add a voucher',
            body: 'Codes students can claim on campus',
            icon: TicketPercent,
            accent: 'bg-[#EEF2FF] text-[#1D4ED8]',
        },
        {
            href: '/vendor/integration',
            title: 'Connect your site',
            body: 'Widget + verification for your storefront',
            icon: Puzzle,
            accent: 'bg-emerald-50 text-emerald-700',
        },
    ];

    const stats = [
        {
            label: 'Revenue',
            value: isLoading ? '…' : formatCurrency(overall?.totalRevenue ?? 0),
            hint: isQuiet ? 'Appears after first completed purchase' : 'Completed sales volume',
            icon: TrendingUp,
            tint: 'from-[#EEF2FF] to-white',
        },
        {
            label: 'Your earnings',
            value: isLoading ? '…' : formatCurrency(overall?.totalEarnings ?? 0),
            hint: isQuiet ? 'Net after platform commission' : 'After platform commission',
            icon: Wallet,
            tint: 'from-emerald-50 to-white',
        },
        {
            label: 'Commission',
            value: isLoading ? '…' : formatCurrency(overall?.totalCommission ?? 0),
            hint: isQuiet ? 'Platform fee on completed sales' : `${completedOrders} completed order${completedOrders === 1 ? '' : 's'}`,
            icon: Percent,
            tint: 'from-sky-50 to-white',
        },
    ];

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle=""
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyName ?? undefined,
                    profileHref: '/vendor/settings',
                    avatarUrl: null,
                }}
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
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Vendor home
                                    </p>
                                    <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl text-balance">
                                        Hey {firstName}, here’s your storefront
                                    </h1>
                                    <p className="text-sm text-blue-100/95 leading-relaxed text-pretty md:text-[15px]">
                                        {!isVerified
                                            ? 'Unlock deals, payouts, and analytics once your inbox is confirmed.'
                                            : isQuiet
                                              ? 'Publish deals and watch purchases, commission, and earnings land here.'
                                              : 'Live sales and commission from completed marketplace purchases.'}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Link href="/vendor/deals/new">
                                        <Button className="rounded-full bg-white text-[#1D4ED8] hover:bg-blue-50 font-bold">
                                            New deal
                                        </Button>
                                    </Link>
                                    <Link href="/vendor/analytics">
                                        <Button
                                            variant="outline"
                                            className="rounded-full border-white/40 bg-white/10 text-white hover:bg-white/20 font-bold"
                                        >
                                            Analytics
                                        </Button>
                                    </Link>
                                </div>
                            </div>
                        </section>
                    </FadeIn>

                    <FadeIn delay={0.05}>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {quickActions.map((action) => {
                                const Icon = action.icon;
                                return (
                                    <Link
                                        key={action.href}
                                        href={action.href}
                                        className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 transition-shadow hover:shadow-md"
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
                        <section className="grid gap-4 sm:grid-cols-3">
                            {stats.map((stat) => {
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
                        <section className="grid gap-4 lg:grid-cols-[1.6fr,1fr]">
                            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 md:p-6">
                                <div className="mb-5 flex items-center justify-between gap-3">
                                    <div>
                                        <p className="font-bold text-slate-900">Orders this week</p>
                                        <p className="text-xs text-slate-500 mt-0.5">Completed purchases by day</p>
                                    </div>
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                                        Last 7 days
                                    </span>
                                </div>
                                {isQuiet ? (
                                    <div className="flex h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-[#1D4ED8]/25 bg-gradient-to-br from-[#F8FAFF] to-[#EEF4FF] px-6 text-center">
                                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#1D4ED8] text-white shadow-lg shadow-[#1D4ED8]/25">
                                            <BarChart3 className="h-6 w-6" />
                                        </div>
                                        <p className="font-bold text-slate-900">Chart wakes up with activity</p>
                                        <p className="mt-1 max-w-sm text-sm text-slate-500 leading-relaxed">
                                            Publish a deal and this graph will fill with real student purchases.
                                        </p>
                                        <Link
                                            href="/vendor/deals/new"
                                            className="mt-4 text-sm font-bold text-[#1D4ED8] hover:underline"
                                        >
                                            Create your first deal →
                                        </Link>
                                    </div>
                                ) : (
                                    <div className="flex h-52 items-end justify-between gap-2 rounded-xl bg-slate-50/80 p-4">
                                        {last7.map((day, index) => (
                                            <div
                                                key={`${day.label}-${index}`}
                                                className="flex h-full w-full flex-col items-center justify-end gap-2"
                                                title={`${day.orders} orders · ${formatCurrency(day.revenue)}`}
                                            >
                                                <div
                                                    className="w-full max-w-[2.5rem] rounded-t-lg bg-gradient-to-t from-[#1D4ED8] to-[#60A5FA] transition-all"
                                                    style={{
                                                        height: `${Math.max(8, (day.orders / maxChart) * 100)}%`,
                                                    }}
                                                />
                                                <span className="text-[10px] font-medium text-slate-500">
                                                    {day.label}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 md:p-6">
                                <p className="font-bold text-slate-900">Top products</p>
                                <p className="text-xs text-slate-500 mt-0.5 mb-5">By completed revenue</p>
                                {isQuiet || topProducts.length === 0 ? (
                                    <div className="space-y-3">
                                        <p className="text-sm text-slate-500 leading-relaxed">
                                            Product rankings appear after students complete purchases.
                                        </p>
                                        <Link
                                            href="/vendor/analytics"
                                            className="text-sm font-bold text-[#1D4ED8] hover:underline"
                                        >
                                            Open analytics →
                                        </Link>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-4">
                                        {topProducts.map((product) => (
                                            <div
                                                key={product.id}
                                                className="flex items-center justify-between gap-3 text-sm"
                                            >
                                                <span className="truncate text-slate-600">{product.name}</span>
                                                <span className="shrink-0 font-bold text-slate-900">
                                                    {formatCurrency(product.revenue)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </section>
                    </FadeIn>

                    <FadeIn delay={0.16}>
                        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 md:p-6">
                            <div className="mb-4 flex items-center justify-between gap-3">
                                <div>
                                    <p className="font-bold text-slate-900">Recent activity</p>
                                    <p className="text-xs text-slate-500 mt-0.5">Latest marketplace purchases</p>
                                </div>
                                <Link
                                    href="/vendor/orders"
                                    className="text-sm font-semibold text-[#1D4ED8] hover:underline"
                                >
                                    View orders
                                </Link>
                            </div>
                            {isLoading ? (
                                <p className="py-8 text-center text-sm text-slate-500">Loading orders…</p>
                            ) : recentOrders.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-12 text-center">
                                    <ShoppingBag className="mx-auto h-8 w-8 text-slate-300" />
                                    <p className="mt-3 font-bold text-slate-900">No purchases yet</p>
                                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 leading-relaxed">
                                        When a student buys your deal, it will show up here with status and time.
                                    </p>
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full text-left text-sm text-slate-600">
                                        <thead>
                                            <tr className="text-xs uppercase tracking-wide text-slate-400">
                                                <th className="px-4 py-3 font-semibold">Student</th>
                                                <th className="px-4 py-3 font-semibold">Deal</th>
                                                <th className="px-4 py-3 font-semibold">Amount</th>
                                                <th className="px-4 py-3 font-semibold">When</th>
                                                <th className="px-4 py-3 font-semibold">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {recentOrders.map((row) => (
                                                <tr key={row.id} className="border-t border-slate-100">
                                                    <td className="px-4 py-4 font-medium text-slate-900">
                                                        {row.student?.name || row.student?.email || 'Student'}
                                                    </td>
                                                    <td className="px-4 py-4">{row.product?.name ?? '—'}</td>
                                                    <td className="px-4 py-4">{formatCurrency(row.amount)}</td>
                                                    <td className="px-4 py-4 text-slate-500">
                                                        {formatWhen(row.createdAt)}
                                                    </td>
                                                    <td className="px-4 py-4">
                                                        <span
                                                            className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusTone(row.status)}`}
                                                        >
                                                            {row.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    </FadeIn>
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}

export default function VendorDashboardPage() {
    return (
        <Suspense
            fallback={
                <div className="flex min-h-screen items-center justify-center bg-[#F4F7FD] text-slate-500">
                    Loading dashboard…
                </div>
            }
        >
            <VendorDashboardContent />
        </Suspense>
    );
}
