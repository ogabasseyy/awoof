import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export default function Banner() {
  return (
    <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-20">
      <div>
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-100/90">
          Student verification
        </p>
        <h1 className="mt-4 max-w-xl text-balance text-4xl font-extrabold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
          Verify your student status. Unlock student benefits.
        </h1>
        <p className="mt-5 max-w-md text-base leading-relaxed text-blue-50/95 sm:text-lg">
          Awoof checks that you are currently enrolled, so participating
          merchants can offer you student benefits. A clear yes, pending, or
          no — never a mystery badge.
        </p>
        <div className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/marketplace"
            className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-white px-7 text-base font-bold text-[#1D4ED8] hover:bg-blue-50"
          >
            Find student benefits
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="#how-it-works"
            className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border-2 border-white/80 px-7 text-base font-bold text-white hover:bg-white/15"
          >
            How verification works
          </Link>
        </div>
      </div>
      <div className="mx-auto w-full max-w-md">
        <div
          role="img"
          aria-label="Illustrative sample of verification states: school account confirmed, enrollment pending"
          className="rotate-[-2deg] rounded-3xl p-7 shadow-xl shadow-blue-900/20"
          style={{ background: 'var(--public-accent)' }}
        >
          <div className="flex items-center justify-between">
            <p className="text-2xl font-extrabold tracking-tight text-[#172e68]">awoof✳</p>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#172e68]/70">
              Illustrative sample
            </p>
          </div>
          <p className="mt-6 text-3xl font-bold leading-tight tracking-tight text-[#172e68]">
            Made for what&apos;s next.
          </p>
          <dl className="mt-6 space-y-3 border-t-2 border-dashed border-[#172e68]/25 pt-5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="font-medium text-[#172e68]/80">School account</dt>
              <dd className="font-bold text-[#172e68]">Confirmed ✓</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="font-medium text-[#172e68]/80">Current enrollment</dt>
              <dd className="font-bold text-[#172e68]">Pending ◷</dd>
            </div>
          </dl>
        </div>
        <p className="mt-3 text-center text-xs text-blue-100/80">
          Sample states for illustration — not your account.
        </p>
      </div>
    </div>
  );
}
