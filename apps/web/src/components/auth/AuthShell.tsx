'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import Logo from '@/app/components/logo';
import { FadeIn } from '@/components/motion/Reveal';

export type AuthRole = 'student' | 'vendor' | 'admin' | 'generic';

const ROLE_PANEL: Record<
    AuthRole,
    { headline: string; line: string; accent: string }
> = {
    student: {
        headline: 'Student deals, unlocked',
        line: 'Verify once. Save on food, tech, fashion, and more from brands that want you on campus.',
        accent: 'Campus-ready savings',
    },
    vendor: {
        headline: 'Reach verified students',
        line: "List deals, track redemptions, and grow with Nigeria's student marketplace.",
        accent: 'Built for campus commerce',
    },
    admin: {
        headline: 'Awoof Admin',
        line: 'Manage universities, vendors, and platform health in one place.',
        accent: 'Operations console',
    },
    generic: {
        headline: 'Welcome to Awoof',
        line: 'Exclusive student discounts — and tools for the brands that serve them.',
        accent: 'Student marketplace',
    },
};

type AuthShellProps = {
    role?: AuthRole;
    title: string;
    subtitle?: string;
    children: ReactNode;
    footer?: ReactNode;
    maxWidthClass?: string;
};

export function AuthShell({
    role = 'generic',
    title,
    subtitle,
    children,
    footer,
    maxWidthClass = 'max-w-md',
}: AuthShellProps) {
    const panel = ROLE_PANEL[role];

    return (
        <div className="min-h-screen flex bg-[#F4F7FD]">
            {/* Brand panel */}
            <aside className="relative hidden lg:flex lg:w-[44%] xl:w-[46%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#1D4ED8] via-[#2563EB] to-[#1E3A8A] p-10 xl:p-14 text-white">
                <div
                    className="pointer-events-none absolute inset-0 opacity-40"
                    style={{
                        backgroundImage:
                            'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.25), transparent 45%), radial-gradient(circle at 80% 70%, rgba(147,197,253,0.35), transparent 40%)',
                    }}
                />
                <FadeIn>
                    <Link href="/" className="relative inline-block">
                        <Logo color="white" width={132} height={36} />
                    </Link>
                </FadeIn>

                <FadeIn delay={0.12} className="relative z-10 max-w-md">
                    <p className="text-sm font-semibold text-blue-100/90 mb-3">
                        {panel.accent}
                    </p>
                    <h2
                        className="text-3xl xl:text-4xl font-extrabold leading-tight tracking-tight text-balance"
                        style={{ textWrap: 'balance' as never }}
                    >
                        {panel.headline}
                    </h2>
                    <p className="mt-4 text-base xl:text-lg text-blue-50/90 leading-relaxed">
                        {panel.line}
                    </p>
                </FadeIn>

                <FadeIn delay={0.2} className="relative z-10">
                    <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm px-5 py-4">
                        <p className="text-sm font-medium text-blue-50/95 leading-relaxed">
                            Free for students. Built for brands that want campus customers.
                        </p>
                    </div>
                </FadeIn>
            </aside>

            {/* Form column */}
            <main className="flex flex-1 flex-col justify-center px-5 py-10 sm:px-8 lg:px-12 xl:px-16 overflow-y-auto">
                <div className={`mx-auto w-full ${maxWidthClass}`}>
                    <FadeIn className="mb-8 lg:hidden">
                        <Link href="/" className="inline-block">
                            <Logo color="blue" width={120} height={32} />
                        </Link>
                    </FadeIn>

                    <FadeIn delay={0.05}>
                        <h1
                            className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 text-balance"
                            style={{ textWrap: 'balance' as never }}
                        >
                            {title}
                        </h1>
                        {subtitle && (
                            <p className="mt-2 text-slate-600 leading-relaxed">
                                {subtitle}
                            </p>
                        )}
                    </FadeIn>

                    <FadeIn delay={0.12} className="mt-8">
                        {children}
                    </FadeIn>

                    {footer && (
                        <FadeIn delay={0.18} className="mt-8">
                            {footer}
                        </FadeIn>
                    )}
                </div>
            </main>
        </div>
    );
}
