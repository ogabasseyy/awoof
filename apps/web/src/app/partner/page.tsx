import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { merchantSteps, partnerIntro, universityBody } from '@/content/public/partners';

export const metadata = buildPublicMetadata(publicPageMetadata['/partner']);

export default function PartnerPage() {
  return (
    <PublicPage title="Student verification for partners" intro={partnerIntro}>
      <div className="max-w-3xl space-y-10">
        <section aria-labelledby="merchant-journey">
          <h2 id="merchant-journey" className="text-2xl font-extrabold tracking-tight text-slate-900">
            How partnering works
          </h2>
          <ol className="mt-6 space-y-4">
            {merchantSteps.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <div
                  aria-hidden="true"
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#244ee7] font-bold text-white"
                >
                  {index + 1}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
                  <h3 className="font-bold text-slate-900">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6 rounded-2xl bg-amber-50 px-5 py-4 ring-1 ring-amber-200">
            <p className="text-sm leading-relaxed text-amber-900">
              Browser widget verification is unavailable: the verification widget
              page is retired. The supported integration path is the server API
              described in the developer guide.
            </p>
          </div>
          <nav aria-label="Merchant account" className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/auth/vendor/register"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
            >
              Vendor register
            </Link>
            <Link
              href="/auth/vendor/login"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
            >
              Vendor sign in
            </Link>
            <Link
              href="/developers"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
            >
              Developer guide
            </Link>
          </nav>
        </section>
        <section aria-labelledby="partner-legal">
          <h2 id="partner-legal" className="text-2xl font-extrabold tracking-tight text-slate-900">
            Partner legal documents
          </h2>
          <p className="mt-3 leading-relaxed text-slate-600">
            Business use is governed by an accepted order under the Merchant Partnership Terms.
            Personal-data exchange additionally needs the Partner Data-Protection Schedule with
            completed annexes.
          </p>
          <nav aria-label="Partner legal documents" className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/legal/merchant-terms"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
            >
              Merchant partnership terms
            </Link>
            <Link
              href="/legal/data-protection"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
            >
              Partner data-protection schedule
            </Link>
          </nav>
        </section>
        <section aria-labelledby="universities-heading" id="universities" className="scroll-mt-24">
          <h2 id="universities-heading" className="text-2xl font-extrabold tracking-tight text-slate-900">
            For universities
          </h2>
          {universityBody.map((paragraph) => (
            <p key={paragraph.slice(0, 32)} className="mt-3 leading-relaxed text-slate-600">
              {paragraph}
            </p>
          ))}
        </section>
      </div>
    </PublicPage>
  );
}
