import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, CircleAlert, GraduationCap, LoaderCircle } from 'lucide-react';
import Logo from '@/app/components/logo';

type MicrosoftCallbackShellProps = {
    label: string;
    provider?: 'microsoft' | 'google' | 'school';
    title: string;
    subtitle?: string;
    status?: 'loading' | 'connected' | 'attention' | 'neutral';
    children: ReactNode;
};

/** Presentation only: outcomes and navigation stay owned by the callback. */
export function MicrosoftCallbackShell({
    label,
    provider = 'microsoft',
    title,
    subtitle,
    status = 'neutral',
    children,
}: MicrosoftCallbackShellProps) {
    return (
        <main className="flex min-h-screen flex-col bg-[#F4F7FD] px-5 py-8 text-slate-900 sm:px-8 sm:py-12">
            <header className="mx-auto w-full max-w-lg">
                <Link href="/" className="inline-flex min-h-11 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D4ED8] focus-visible:ring-offset-4">
                    <Logo width={120} height={32} />
                </Link>
            </header>

            <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-10 sm:py-14">
                <section aria-labelledby="callback-heading" className="overflow-hidden rounded-[2rem] border border-blue-100 bg-white shadow-[0_16px_60px_-24px_rgba(29,78,216,0.22)]">
                    <div className="relative overflow-hidden bg-[#1D4ED8] px-7 py-8 text-white sm:px-9">
                        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-60 w-60 rounded-full border-[32px] border-white/10" />
                        <p className="relative text-xs font-bold uppercase tracking-[0.16em] text-blue-100">Back to Awoof</p>
                        <div aria-hidden="true" className="relative mt-6 flex items-center gap-4">
                            {provider === 'microsoft' ? (
                                <div className="grid h-14 w-14 grid-cols-2 gap-1 rounded-2xl bg-white p-3 shadow-sm">
                                    <span className="bg-[#F25022]" />
                                    <span className="bg-[#7FBA00]" />
                                    <span className="bg-[#00A4EF]" />
                                    <span className="bg-[#FFB900]" />
                                </div>
                            ) : (
                                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-[#1D4ED8] shadow-sm">
                                    <GraduationCap className="h-7 w-7" />
                                </div>
                            )}
                            <div className="flex flex-1 items-center gap-2 text-blue-200">
                                <span className="h-px flex-1 bg-white/30" />
                                <ArrowRight className="h-5 w-5" />
                                <span className="h-px flex-1 bg-white/30" />
                            </div>
                            <div className="flex h-14 items-center rounded-2xl bg-white/10 px-4 ring-1 ring-inset ring-white/20">
                                <Logo color="white" width={85} height={24} />
                            </div>
                        </div>
                        <p className="relative mt-5 text-sm font-medium text-blue-50">{provider === 'microsoft' ? 'Microsoft' : provider === 'google' ? 'Google' : 'School account'} · Awoof</p>
                    </div>

                    <div className="px-7 py-8 sm:px-9 sm:py-9">
                        <div className="mb-5 flex items-center gap-3">
                            <span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${status === 'connected' ? 'bg-emerald-50 text-emerald-700' : status === 'attention' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-[#1D4ED8]'}`}>
                                {status === 'loading' ? <LoaderCircle className="h-5 w-5 motion-safe:animate-spin" /> : status === 'connected' ? <Check className="h-5 w-5" /> : status === 'attention' ? <CircleAlert className="h-5 w-5" /> : <ArrowRight className="h-5 w-5" />}
                            </span>
                            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
                        </div>
                        <h1 id="callback-heading" className="text-2xl font-extrabold leading-tight tracking-tight text-balance sm:text-3xl">{title}</h1>
                        {subtitle && <p className="mt-3 text-sm leading-6 text-slate-600">{subtitle}</p>}
                        <div className="mt-4 text-sm leading-6 text-slate-600">{children}</div>
                    </div>
                </section>

                <p className="mt-6 px-2 text-center text-xs leading-5 text-slate-500">
                    Account connection and current enrollment eligibility are separate checks.
                </p>
                <nav aria-label="Legal information" className="mt-3 flex justify-center gap-5 text-xs text-slate-600">
                    <Link href="/privacy" className="inline-flex min-h-11 items-center rounded-md underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D4ED8] focus-visible:ring-offset-2">Privacy notice</Link>
                    <Link href="/terms" className="inline-flex min-h-11 items-center rounded-md underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D4ED8] focus-visible:ring-offset-2">Terms of service</Link>
                </nav>
            </div>
        </main>
    );
}
