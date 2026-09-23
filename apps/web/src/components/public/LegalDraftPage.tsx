import Link from 'next/link';
import PublicShell from './PublicShell';
import { legalDocuments, legalDraftVersion, type LegalDraftSection } from '@/content/public/legal-drafts';

export default function LegalDraftPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: string;
  sections: readonly LegalDraftSection[];
}) {
  return (
    <PublicShell>
      <div className="mx-auto max-w-7xl px-4 pb-20 pt-10 sm:px-6 lg:px-8">
        <div className="inline-flex rounded-full border border-[#afcc2a] bg-[#eaff8c] px-4 py-2 text-xs font-extrabold uppercase tracking-[0.12em] text-[#1b2d62]">
          Awoof legal information
        </div>
        <p className="mt-3 text-sm text-slate-600">{legalDraftVersion}</p>
        <nav aria-label="Legal documents" className="mt-5 flex flex-wrap gap-x-5 gap-y-3 text-sm font-semibold text-[#182d75] print:hidden">
          <Link className="underline underline-offset-4" href="/legal">Legal information</Link>
          {legalDocuments.map((document) => <Link key={document.href} className="underline underline-offset-4" href={document.href}>{document.label}</Link>)}
        </nav>
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-16">
          <article className="min-w-0">
            <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight text-slate-950 sm:text-5xl">{title}</h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">{intro}</p>
            <div className="mt-8 rounded-2xl border-l-4 border-[#244ee7] bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-sm">
              Questions about these documents? Contact support@awoof.tech. Merchant terms and the partner data-protection schedule apply only through a separately agreed contract and completed annexes.
            </div>
            <div className="mt-12 space-y-12">
              {sections.map((section, index) => (
                <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24 border-t border-slate-200 pt-8">
                  <div className="flex items-start gap-4">
                    <span aria-hidden="true" className="pt-1 text-sm font-extrabold text-[#244ee7]">{String(index + 1).padStart(2, '0')}</span>
                    <div className="min-w-0">
                      <h2 id={`${section.id}-heading`} className="text-2xl font-extrabold tracking-tight text-slate-950">{section.heading}</h2>
                      {section.paragraphs.map((paragraph) => (
                        <p key={paragraph.slice(0, 64)} className="mt-4 max-w-3xl leading-7 text-slate-700">{paragraph}</p>
                      ))}
                      {section.points && (
                        <ul className="mt-4 list-disc space-y-2 pl-6 leading-7 text-slate-700">
                          {section.points.map((point) => <li key={point}>{point}</li>)}
                        </ul>
                      )}
                      {section.links && <ul className="mt-4 space-y-2">
                        {section.links.map((link) => <li key={link.href}><Link className="font-semibold text-[#182d75] underline underline-offset-4" href={link.href}>{link.label}</Link></li>)}
                      </ul>}
                    </div>
                  </div>
                </section>
              ))}
            </div>
            <nav aria-label="Related information" className="mt-14 flex flex-wrap gap-3 border-t border-slate-200 pt-8">
              <Link className="rounded-full bg-[#244ee7] px-5 py-3 text-sm font-bold text-white hover:brightness-110" href="/trust">How verification works</Link>
              <Link className="rounded-full border border-slate-300 px-5 py-3 text-sm font-bold text-[#182d75] hover:bg-white" href="/contact">Contact options</Link>
              <a className="rounded-full border border-slate-300 px-5 py-3 text-sm font-bold text-[#182d75] hover:bg-white" href="mailto:support@awoof.tech">support@awoof.tech</a>
            </nav>
          </article>
          <nav aria-label={`${title} sections`} className="h-fit rounded-2xl border border-slate-200 bg-white p-6 lg:sticky lg:top-8 lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto print:hidden">
            <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#244ee7]">On this page</h2>
            <ol className="mt-4 space-y-3">
              {sections.map((section) => (
                <li key={section.id}>
                  <a className="text-sm font-semibold leading-relaxed text-slate-700 underline-offset-4 hover:text-[#244ee7] hover:underline focus-visible:underline" href={`#${section.id}`}>{section.heading}</a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </div>
    </PublicShell>
  );
}
