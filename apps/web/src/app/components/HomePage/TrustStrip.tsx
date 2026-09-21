import Link from 'next/link';

export default function TrustStrip() {
  return (
    <section aria-labelledby="trust-strip-heading" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="rounded-3xl bg-[#e8edf9] p-8 sm:p-10">
        <h2 id="trust-strip-heading" className="max-w-2xl text-balance text-2xl font-extrabold tracking-tight text-[#182d75] sm:text-3xl">
          Verification you can inspect
        </h2>
        <p className="mt-3 max-w-2xl leading-relaxed text-[#182d75]/80">
          See what is checked, what merchants learn, and what each status means —
          including what happens when a check cannot complete.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/trust"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
          >
            Trust center
          </Link>
          <Link
            href="/help"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white/60"
          >
            Get help
          </Link>
        </div>
      </div>
    </section>
  );
}
