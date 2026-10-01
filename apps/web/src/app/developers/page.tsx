import Link from 'next/link';
import PublicPage from '@/components/public/PublicPage';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import { developerExamples, developerIntro, developerSeparations, developerGuideSections, partnerConnections } from '@/content/public/partners';

export const metadata = buildPublicMetadata(publicPageMetadata['/developers']);

export default function DevelopersPage() {
  return (
    <PublicPage title="Developer integration guide" intro={developerIntro}>
      <div className="max-w-3xl space-y-10 [overflow-wrap:anywhere]">
        <p className="rounded-2xl bg-slate-100 px-5 py-4 text-sm leading-relaxed text-slate-600">
          All values below are synthetic samples shaped like the real schemas.
          Never paste real keys or codes into docs, chats, or tickets.
        </p>
        <nav aria-label="Guide sections" className="flex flex-wrap gap-x-5 gap-y-3 text-sm font-semibold text-[#3858bb]">
          {developerGuideSections.map((section) => <Link key={section.id} href={`#${section.id}`} className="min-h-[44px] inline-flex items-center underline">{section.title}</Link>)}
          <Link href="#connections" className="min-h-[44px] inline-flex items-center underline">Partner connection options</Link>
        </nav>
        <section aria-labelledby="downloads">
          <h2 id="downloads" className="text-2xl font-extrabold tracking-tight text-slate-900">Merchant starter and API reference</h2>
          <p className="mt-3 leading-relaxed text-slate-600">Download the source starter, extract it and follow examples/merchant-integration/README.md. It includes the SDK, a merchant backend and disposable local simulator. Use Node 24. The API reference includes merchant-facing contracts only; use the API base supplied during onboarding for real-backend calls.</p>
          <h3 className="mt-5 font-bold text-slate-900">Run the disposable local example</h3>
          <pre tabIndex={0} aria-label="Local synthetic merchant commands" className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">{`# From the extracted starter root, with Node 24; two terminals:
AWOOF_SYNTHETIC=1 npm --prefix examples/merchant-integration run simulator
AWOOF_SYNTHETIC=1 npm --prefix examples/merchant-integration start
# Open http://127.0.0.1:4100
npm --prefix packages/partner-sdk test
npm --prefix examples/merchant-integration test`}</pre>
          <p className="mt-3 leading-relaxed text-slate-600">For the real-backend test mode, configure AWOOF_API_ORIGIN, AWOOF_WEB_ORIGIN, AWOOF_PRIVATE_KEY, AWOOF_PRODUCT_ID, AWOOF_VENDOR_ID, MERCHANT_ORIGIN (HTTPS), STUDENT_PRICE_KOBO and PAYMENT_GATEWAY as described in the starter README. AWOOF_API_ORIGIN is the HTTPS API origin without /api or another path; AWOOF_WEB_ORIGIN is the HTTPS hosted web origin. For independent Paystack test payments, MERCHANT_PAYSTACK_TEST_SECRET stays on your merchant server; the Awoof operator separately configures PAYSTACK_MERCHANT_SECRET_KEYS. Use only the provider test environment for this example. The reference has no payment UI or charge initialization. For platform Paystack or merchant-attested reporting, set REFERENCE_REPORT_SECRET (at least 32 characters) and call its server-authenticated POST /payments/report; never expose that endpoint credential to the browser. For independent merchant test payments, the reference receives signed events at /webhooks/paystack, verifies raw bytes and requeries the trusted test transaction. Follow the README for the exact server-only report payload.</p>
          <nav aria-label="Merchant downloads" className="mt-4 flex flex-wrap gap-4">
            <a href="/developers/merchant-starter.tar.gz" className="min-h-[44px] inline-flex items-center font-semibold text-[#3858bb] underline">Download merchant starter</a>
            <a href="/developers/merchant-api.json" className="min-h-[44px] inline-flex items-center font-semibold text-[#3858bb] underline">Download merchant OpenAPI</a>
          </nav>
        </section>
        {developerGuideSections.map((section) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24">
            <h2 id={`${section.id}-heading`} className="text-2xl font-extrabold tracking-tight text-slate-900">{section.title}</h2>
            {section.paragraphs.map((paragraph) => <p key={paragraph.slice(0, 48)} className="mt-3 leading-relaxed text-slate-600">{paragraph}</p>)}
          </section>
        ))}
        {[developerExamples[3], developerExamples[1], developerExamples[2], developerExamples[0]].map((example, index) => (
          <section key={example.title} aria-labelledby={`dev-section-${index}`}>
            <h2 id={`dev-section-${index}`} className="text-2xl font-extrabold tracking-tight text-slate-900">{example.title}</h2>
            <p className="mt-2 font-mono text-sm text-[#3858bb]">{example.route}</p>
            <p className="mt-3 leading-relaxed text-slate-600">{example.body}</p>
            <h3 className="mt-5 font-bold text-slate-900">Request</h3>
            <pre tabIndex={0} aria-label={`Example request: ${example.route}`} className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
              {example.request}
            </pre>
            <h3 className="mt-5 font-bold text-slate-900">Response</h3>
            <pre tabIndex={0} aria-label="Example response" className="mt-2 overflow-x-auto rounded-2xl bg-slate-900 p-5 text-sm leading-relaxed text-slate-100">
              {example.response}
            </pre>
          </section>
        ))}
        <section id="connections" aria-labelledby="connections-heading" className="scroll-mt-24">
          <h2 id="connections-heading" className="text-2xl font-extrabold tracking-tight text-slate-900">Choose a partner connection</h2>
          <p className="mt-3 leading-relaxed text-slate-600">Capability adapters separate identity, enrollment authority, offer fulfillment, redemption and authenticated payment events. Missing configuration returns unconfigured; a provider name never grants a benefit.</p>
          <dl className="mt-5 space-y-5">{partnerConnections.map((connection) => <div key={connection.title}><dt className="font-bold text-slate-900">{connection.title}</dt><dd className="mt-1 leading-relaxed text-slate-600">{connection.body}</dd></div>)}</dl>
          <p className="mt-5 leading-relaxed text-slate-600">Keep an onboarding record of environment, capability, approved offer and sharing purpose, evidence authority, contract version, credentials, test vectors, support owner and activation evidence. Prospective Google/Verve connections require provider contracts; these portable boundaries do not implement fictional provider endpoints.</p>
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
