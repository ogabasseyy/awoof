import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { trustIntro, trustSections } from '@/content/public/trust';

export const metadata = buildPublicMetadata(publicPageMetadata['/trust']);

export default function TrustPage() {
  return (
    <PublicPage title="Security and trust" intro={trustIntro}>
      <div className="max-w-3xl space-y-10">
        {trustSections.map((section, index) => (
          <section key={section.heading} aria-labelledby={`section-${index}`}>
            <h2 id={`section-${index}`} className="text-2xl font-extrabold tracking-tight text-slate-900">
              {section.heading}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 32)} className="mt-3 leading-relaxed text-slate-600">
                {paragraph}
              </p>
            ))}
            {section.list && (
              <ol className="mt-4 list-decimal space-y-2 pl-6 leading-relaxed text-slate-600">
                {section.list.map((item) => (
                  <li key={item.slice(0, 32)}>{item}</li>
                ))}
              </ol>
            )}
          </section>
        ))}
        <nav aria-label="Trust next steps" className="flex flex-col gap-3 pt-2 sm:flex-row">
          <Link
            href="/help"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
          >
            Get help
          </Link>
          <Link
            href="/contact"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
          >
            Contact support
          </Link>
        </nav>
      </div>
    </PublicPage>
  );
}
