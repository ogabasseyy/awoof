import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { contactIntro, contactSections } from '@/content/public/contact';

export const metadata = buildPublicMetadata(publicPageMetadata['/contact']);

export default function ContactPage() {
  return (
    <PublicPage title="Contact Awoof" intro={contactIntro}>
      <div className="max-w-3xl space-y-10">
        {contactSections.map((section, index) => (
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
        <nav aria-label="Sign in for support" className="flex flex-col gap-3 pt-2 sm:flex-row">
          <a
            href="mailto:support@awoof.tech"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
          >
            support@awoof.tech
          </a>
          <Link
            href="/auth/student/login"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
          >
            Student sign in
          </Link>
          <Link
            href="/auth/vendor/login"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
          >
            Vendor sign in
          </Link>
        </nav>
      </div>
    </PublicPage>
  );
}
