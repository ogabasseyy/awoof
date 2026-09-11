'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { Gift, Sparkles, Ticket, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function FadeIn({
    children,
    delay = 0,
    className,
}: {
    children: ReactNode;
    delay?: number;
    className?: string;
}) {
    const reduce = useReducedMotion();
    if (reduce) {
        return <div className={className}>{children}</div>;
    }
    return (
        <motion.div
            className={className}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
        >
            {children}
        </motion.div>
    );
}

/** Soft shimmer placeholders — shows where deals will land */
export function DealSkeletonRail({ count = 3 }: { count?: number }) {
    return (
        <div className="flex gap-4 overflow-hidden pb-2">
            {Array.from({ length: count }).map((_, i) => (
                <div
                    key={i}
                    className="shrink-0 w-64 md:w-72 rounded-2xl border border-[#1D4ED8]/10 bg-white overflow-hidden"
                    style={{ animationDelay: `${i * 120}ms` }}
                >
                    <div className="h-36 bg-gradient-to-br from-[#EEF2FF] via-[#E0E7FF] to-[#DBEAFE] relative overflow-hidden">
                        <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                    </div>
                    <div className="p-4 space-y-3">
                        <div className="h-3 w-2/3 rounded-full bg-slate-100" />
                        <div className="h-3 w-1/3 rounded-full bg-slate-100" />
                        <div className="h-8 w-24 rounded-full bg-[#1D4ED8]/10" />
                    </div>
                </div>
            ))}
        </div>
    );
}

type EmptyKind = 'deals' | 'vouchers' | 'category';

const EMPTY_COPY: Record<
    EmptyKind,
    { title: string; body: string; icon: typeof Gift; cta?: { href: string; label: string } }
> = {
    deals: {
        title: 'Fresh deals are on the way',
        body: 'Campus partners are lining up student-only offers. Check back soon — or finish verifying so you’re ready the second they drop.',
        icon: Sparkles,
        cta: { href: '/student/profile', label: 'Complete your profile' },
    },
    vouchers: {
        title: 'Vouchers coming soon',
        body: 'Exclusive student vouchers will show up here as brands join Awoof. You’ll be first to claim them.',
        icon: Ticket,
    },
    category: {
        title: 'Nothing in this lane yet',
        body: 'We’re stocking this category. Browse another, or hang tight — new merchants are joining weekly.',
        icon: Gift,
    },
};

export function ExpectancyEmpty({ kind }: { kind: EmptyKind }) {
    const copy = EMPTY_COPY[kind];
    const Icon = copy.icon;
    const reduce = useReducedMotion();

    return (
        <div className="w-full rounded-2xl border border-dashed border-[#1D4ED8]/25 bg-gradient-to-br from-[#F8FAFF] to-[#EEF4FF] px-6 py-10 md:px-10 md:py-12">
            <div className="flex flex-col md:flex-row md:items-center gap-6 md:gap-10 max-w-3xl">
                <div
                    className={`shrink-0 w-16 h-16 rounded-2xl bg-[#1D4ED8] text-white flex items-center justify-center shadow-lg shadow-[#1D4ED8]/25 ${
                        reduce ? '' : 'animate-[float_4s_ease-in-out_infinite]'
                    }`}
                >
                    <Icon className="h-7 w-7" />
                </div>
                <div className="flex-1 space-y-2">
                    <h3 className="text-lg md:text-xl font-bold text-slate-900 tracking-tight text-balance">
                        {copy.title}
                    </h3>
                    <p className="text-sm md:text-[15px] text-slate-600 leading-relaxed max-w-xl text-pretty">
                        {copy.body}
                    </p>
                    {copy.cta && (
                        <Link
                            href={copy.cta.href}
                            className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-[#1D4ED8] hover:gap-2.5 transition-all"
                        >
                            {copy.cta.label}
                            <ArrowRight className="h-4 w-4" />
                        </Link>
                    )}
                </div>
            </div>
            <div className="mt-8">
                <DealSkeletonRail count={3} />
            </div>
        </div>
    );
}
