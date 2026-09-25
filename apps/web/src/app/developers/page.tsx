import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import {
  developerExamples,
  developerIntro,
  developerPilotBrowserExample,
  developerPilotErrors,
  developerPilotExchangeExample,
  developerPilotReceiptFields,
  developerPilotSteps,
  developerSeparations,
} from '@/content/public/partners';

export const metadata = buildPublicMetadata(publicPageMetadata['/developers']);

export default function DevelopersPage() {
  return (
    <PublicPage title="Developer integration guide" intro={developerIntro}>
      <div className="max-w-3xl space-y-10">
        <p className="rounded-2xl bg-slate-100 px-5 py-4 text-sm leading-relaxed text-slate-600">
          All values below are synthetic samples shaped like the real schemas.
          Never paste real keys or codes into docs, chats, or tickets.
        </p>
        <section id="widget-pilot" aria-labelledby="widget-pilot-heading" className="space-y-6">
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-5 text-amber-950">
            <h2 id="widget-pilot-heading" className="text-2xl font-extrabold tracking-tight">Controlled widget pilot</h2>
            <p className="mt-2 leading-relaxed">
              The hosted widget is disabled by default. This pilot is intended only for an isolated sandbox with allowlisted synthetic accounts and merchants. These instructions describe source behavior for a controlled test, not a live student discount or generally available installation.
            </p>
          </div>
          <ol className="grid gap-4 sm:grid-cols-3">
            {developerPilotSteps.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-slate-200 bg-white p-5">
                <h3 className="font-bold text-slate-900">{index + 1}. {step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </li>
            ))}
          </ol>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Browser: request an opaque code</h3>
            <p className="mt-2 leading-relaxed text-slate-600">The public site key may be used in the browser. The checkout path below is an example route on your own server; it must require your checkout session and CSRF protection. Never send the private Awoof server key to the browser.</p>
            <p className="mt-2 leading-relaxed text-slate-600">This popup handoff requires the merchant page and Awoof hosted page to retain a cross-origin opener connection. The merchant checkout can use the default <code>Cross-Origin-Opener-Policy: unsafe-none</code>, <code>same-origin-allow-popups</code>, or <code>noopener-allow-popups</code> with Awoof&apos;s hosted response set to <code>unsafe-none</code>. <code>same-origin</code> breaks this pilot. Confirm the effective response headers and popup return in the isolated sandbox before use.</p>
            <pre tabIndex={0} aria-label="Controlled widget browser example" className="mt-3 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">{developerPilotBrowserExample}</pre>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Server: exchange the code</h3>
            <p className="mt-2 leading-relaxed text-slate-600">Use the campaign and checkout reference held by your server. Send this request server-to-server with the private merchant key. The code has at most two minutes of life and is consumed once; an exact retry must reuse the same code, campaign and idempotency key.</p>
            <pre tabIndex={0} aria-label="Controlled widget server exchange example" className="mt-3 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">{developerPilotExchangeExample}</pre>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Receipt fields</h3>
            <p className="mt-2 leading-relaxed text-slate-600">A successful exchange returns <code>success: true</code> and a <code>data</code> object with these fields. It applies no price, coupon, or payment rule.</p>
            <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-slate-900"><tr><th scope="col" className="p-3">Field</th><th scope="col" className="p-3">Meaning</th></tr></thead>
                <tbody className="divide-y divide-slate-200 text-slate-600">
                  {developerPilotReceiptFields.map((field) => <tr key={field.name}><th scope="row" className="p-3 font-mono font-medium text-slate-900">{field.name}</th><td className="p-3">{field.meaning}</td></tr>)}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">A <code>benefitAuthorizationId</code> can appear only in a separate product-bound flow. The generic hosted pilot does not request one or authorize a transaction.</p>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Exchange failures</h3>
            <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-slate-900"><tr><th scope="col" className="p-3">HTTP</th><th scope="col" className="p-3">Merchant action</th></tr></thead>
                <tbody className="divide-y divide-slate-200 text-slate-600">
                  {developerPilotErrors.map((error) => <tr key={error.status}><th scope="row" className="p-3 font-mono font-medium text-slate-900">{error.status}</th><td className="p-3">{error.meaning}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-slate-600">Do not place codes in URLs, analytics, logs, or persistent browser storage. A pilot receipt is test-only even when <code>eligible</code> is true. Live use still requires an approved current-enrollment source, merchant integration, and release review. Read <Link href="/trust" className="underline">Security and Trust</Link> and <Link href="/privacy" className="underline">Privacy</Link> for the student-facing context.</p>
        </section>
        <section id="api-reference" aria-labelledby="api-reference-heading" className="space-y-8">
          <div>
            <h2 id="api-reference-heading" className="text-2xl font-extrabold tracking-tight text-slate-900">Other API contracts</h2>
            <p className="mt-2 leading-relaxed text-slate-600">These source-level examples cover direct student assertions, server exchange, transaction reporting, and protected product claims. They are separate from the generic hosted pilot and do not prove that a merchant or enrollment provider is active.</p>
          </div>
          {developerExamples.map((example, index) => (
            <section key={example.title} aria-labelledby={`dev-section-${index}`}>
              <h3 id={`dev-section-${index}`} className="text-xl font-extrabold tracking-tight text-slate-900">{example.title}</h3>
              <p className="mt-2 font-mono text-sm text-[#3858bb]">{example.route}</p>
              <p className="mt-3 leading-relaxed text-slate-600">{example.body}</p>
              <h4 className="mt-5 font-bold text-slate-900">Request</h4>
              <pre tabIndex={0} aria-label={`Example request: ${example.route}`} className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
                {example.request}
              </pre>
              <h4 className="mt-5 font-bold text-slate-900">Response</h4>
              <pre tabIndex={0} aria-label="Example response" className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
                {example.response}
              </pre>
            </section>
          ))}
        </section>
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
