import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { developerExamples, developerIntro, developerSeparations } from '@/content/public/partners';

export const metadata = buildPublicMetadata(publicPageMetadata['/developers']);

export default function DevelopersPage() {
  return (
    <PublicPage title="Developer integration guide" intro={developerIntro}>
      <div className="max-w-3xl space-y-10">
        <p className="rounded-2xl bg-slate-100 px-5 py-4 text-sm leading-relaxed text-slate-600">
          All values below are synthetic samples shaped like the real schemas.
          Never paste real keys or codes into docs, chats, or tickets.
        </p>
        {developerExamples.map((example, index) => (
          <section key={example.title} aria-labelledby={`dev-section-${index}`}>
            <h2 id={`dev-section-${index}`} className="text-2xl font-extrabold tracking-tight text-slate-900">{example.title}</h2>
            <p className="mt-2 font-mono text-sm text-[#3858bb">{example.route}</p>
            <p className="mt-3 leading-relaxed text-slate-600">{example.body}</p>
            <h3 className="mt-5 font-bold text-slate-900">Request</h3>
            <pre className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
              {example.request}
            </pre>
            <h3 className="mt-5 font-bold text-slate-900">Response</h3>
            <pre className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
              {example.response}
            </pre>
          </section>
        ))}
        <section aria-labelledby="separations">
          <h2 id="separations" className="text-2xl font-extrabold tracking-tight text-slate-900">
            Separations that keep students safe
          </h2>
          <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed text-slate-600">
            {developerSeparations.map((item) => (
              <li key={item.slice(0, 32)}>{item}</li>
            ))}
          </ul>
        </section>
        <nav aria-label="Developer next steps" className="flex flex-col gap-3 pt-2 sm:flex-row">
          <Link
            href="/vendor/integration"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#244ee7] px-6 text-sm font-bold text-white hover:brightness-110"
          >
            Open vendor integration
          </Link>
          <Link
            href="/auth/vendor/register"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full border-2 border-[#244ee7]/40 px-6 text-sm font-bold text-[#182d75] hover:bg-white"
          >
            Vendor register
          </Link>
        </nav>
      </div>
    </PublicPage>
  );
}
