/**
 * Student Profile — account hub
 */

'use client';

import { useState, useEffect } from 'react';
import {
    Bell,
    FileText,
    Moon,
    Receipt,
    Headphones,
    LogOut,
    ChevronRight,
    ChevronLeft,
    Sparkles,
    ShieldCheck,
} from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import Image from 'next/image';
import Link from 'next/link';
import { FadeIn } from '@/app/marketplace/_components/ExpectancyUI';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { StudentHeaderActions } from '@/components/student/StudentHeaderActions';
import apiClient from '@/lib/api-client';

type MenuItem = {
    href?: string;
    label: string;
    icon: typeof Bell;
    tone?: 'default' | 'danger';
    onClick?: () => void;
    trailing?: 'chevron' | 'toggle';
};

export default function StudentProfilePage() {
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [darkMode, setDarkMode] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);

    useEffect(() => {
        apiClient
            .get('/support/notifications/unread-count')
            .then((res) => setUnreadCount(res?.data?.data?.unreadCount ?? 0))
            .catch(() => setUnreadCount(0));
    }, []);

    const getInitials = () => {
        if (!user) return 'U';
        const profile = (user as { profile?: { name?: string } })?.profile;
        if (profile?.name) return profile.name.split(' ')[0].charAt(0).toUpperCase();
        if (user.email) return user.email.charAt(0).toUpperCase();
        return 'U';
    };

    const getDisplayName = () => {
        if (!user) return 'User';
        const profile = (user as { profile?: { name?: string } })?.profile;
        if (profile?.name) return profile.name;
        if (user.email) {
            const emailName = user.email.split('@')[0];
            return emailName
                .split('.')
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }
        return 'User';
    };

    const getFirstName = () => {
        const name = getDisplayName();
        return name.split(' ')[0] || 'there';
    };

    const isVerified = user?.verificationStatus === 'verified';

    const handleSignOut = async () => {
        const ok = await confirm({
            title: 'Sign out?',
            description: 'You will need to sign in again to access your account.',
            confirmLabel: 'Sign out',
            variant: 'destructive',
        });
        if (ok) {
            await logout();
        }
    };

    const generalItems: MenuItem[] = [
        { href: '/student/profile/notifications', label: 'Notifications', icon: Bell },
        { href: '/student/profile/websites', label: 'Websites visited', icon: FileText },
        { label: 'Dark mode', icon: Moon, trailing: 'toggle' },
        { href: '/student/profile/receipts', label: 'Receipts', icon: Receipt },
    ];

    const supportItems: MenuItem[] = [
        { href: '/student/profile/support', label: 'Customer support', icon: Headphones },
        {
            label: 'Sign out',
            icon: LogOut,
            tone: 'danger',
            onClick: handleSignOut,
        },
    ];

    const renderRow = (item: MenuItem) => {
        const Icon = item.icon;
        const content = (
            <>
                <div className="flex items-center gap-3 min-w-0">
                    <span
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                            item.tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-[#EEF2FF] text-[#1D4ED8]'
                        }`}
                    >
                        <Icon className="h-5 w-5" />
                    </span>
                    <span
                        className={`font-semibold truncate ${
                            item.tone === 'danger' ? 'text-red-600' : 'text-slate-900'
                        }`}
                    >
                        {item.label}
                    </span>
                    {item.label === 'Notifications' && unreadCount > 0 ? (
                        <span className="ml-auto mr-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#1D4ED8] px-1.5 text-[10px] font-bold text-white">
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    ) : null}
                </div>
                {item.trailing === 'toggle' ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDarkMode(!darkMode);
                        }}
                        aria-label="Toggle dark mode"
                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                            darkMode ? 'bg-[#1D4ED8]' : 'bg-slate-200'
                        }`}
                    >
                        <span
                            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                                darkMode ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                    </button>
                ) : (
                    <ChevronRight
                        className={`h-5 w-5 shrink-0 ${item.tone === 'danger' ? 'text-red-300' : 'text-slate-300'}`}
                    />
                )}
            </>
        );

        const className =
            'flex items-center justify-between gap-3 px-4 py-3.5 bg-white hover:bg-slate-50/80 transition-colors first:rounded-t-2xl last:rounded-b-2xl';

        if (item.href) {
            return (
                <Link key={item.label} href={item.href} className={className}>
                    {content}
                </Link>
            );
        }

        return (
            <button key={item.label} type="button" onClick={item.onClick} className={`w-full text-left ${className}`}>
                {content}
            </button>
        );
    };

    return (
        <ProtectedRoute requiredRole="student">
            <div className="min-h-screen bg-[#F4F7FD] text-slate-900">
                <div
                    aria-hidden
                    className="pointer-events-none fixed inset-0 -z-10"
                    style={{
                        background:
                            'radial-gradient(ellipse 70% 40% at 50% -5%, rgba(29,78,216,0.12), transparent 50%)',
                    }}
                />

                <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/80">
                    <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-3">
                        <Link
                            href="/marketplace"
                            className="flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-[#1D4ED8] transition-colors"
                        >
                            <ChevronLeft className="h-5 w-5" />
                            <span className="hidden sm:inline">Marketplace</span>
                        </Link>
                        <Link href="/marketplace" className="absolute left-1/2 -translate-x-1/2">
                            <Image
                                src="/images/awoofLogoMain.png"
                                alt="Awoof"
                                width={100}
                                height={32}
                                className="object-contain"
                                priority
                            />
                        </Link>
                    <span className="text-sm font-bold text-slate-900 w-16 text-right sm:w-auto hidden sm:inline">
                        Profile
                    </span>
                    <StudentHeaderActions />
                    </div>
                </header>

                <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
                    <FadeIn>
                        <section className="rounded-3xl bg-[#1D4ED8] text-white px-6 py-7 md:px-8 relative overflow-hidden shadow-xl shadow-[#1D4ED8]/20">
                            <div
                                aria-hidden
                                className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl"
                            />
                            <div className="relative flex items-center gap-4 md:gap-5">
                                <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-white text-[#1D4ED8] flex items-center justify-center text-2xl md:text-3xl font-extrabold shadow-lg">
                                    {getInitials()}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-blue-100 text-xs font-semibold uppercase tracking-wider mb-1">
                                        Your account
                                    </p>
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <h1 className="text-xl md:text-2xl font-extrabold tracking-tight truncate">
                                            {getDisplayName()}
                                        </h1>
                                        {isVerified ? (
                                            <span className="inline-flex items-center gap-1 bg-emerald-400 text-emerald-950 text-[11px] font-bold px-2 py-0.5 rounded-full">
                                                <ShieldCheck className="h-3 w-3" />
                                                Verified
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 bg-white/20 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">
                                                Unverified
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-blue-100 truncate">{user?.email}</p>
                                </div>
                            </div>
                            {!isVerified && (
                                <p className="relative mt-5 text-sm text-blue-100 leading-relaxed flex items-start gap-2">
                                    <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
                                    Hey {getFirstName()} — verify your student status so deals unlock the moment they
                                    go live.
                                </p>
                            )}
                            {isVerified && (
                                <p className="relative mt-5 text-sm text-blue-100 leading-relaxed">
                                    You’re all set. Manage alerts, receipts, and support from here.
                                </p>
                            )}
                        </section>
                    </FadeIn>

                    <FadeIn delay={0.06}>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 px-1">
                                General
                            </p>
                            <div className="rounded-2xl border border-slate-200/80 overflow-hidden divide-y divide-slate-100 shadow-sm">
                                {generalItems.map(renderRow)}
                            </div>
                        </div>
                    </FadeIn>

                    <FadeIn delay={0.1}>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 px-1">
                                Support
                            </p>
                            <div className="rounded-2xl border border-slate-200/80 overflow-hidden divide-y divide-slate-100 shadow-sm">
                                {supportItems.map(renderRow)}
                            </div>
                        </div>
                    </FadeIn>
                </main>
            </div>
        </ProtectedRoute>
    );
}
