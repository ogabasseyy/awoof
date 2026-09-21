import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { helpIntro, helpSections } from '@/content/public/help';

export const metadata = buildPublicMetadata(publicPageMetadata['/help']);

export default function HelpPage() {
  return (
    <PublicPage title="Help with verification" intro={helpIntro}>
      <div className="max-w-3xl space-y-10">
        {helpSections.map((section, index) => (
          <section key={section.heading} aria-labelledby={`section-${index}`}>
            <h2 id={`section-${index}`} className="text-2xl font-extrabold tracking-tight text-slate-900">
              {section.heading}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 32)} className="mt-3 leading-relaxed text-slate-600">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
        <nav aria-label="Help next steps" className="flex flex-col gap-3 pt-2 sm:flex-row">
          <Link
            href="/trust"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
          >
            Trust center
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
