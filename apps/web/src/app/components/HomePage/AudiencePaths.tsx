import Link from 'next/link';

const paths = [
  {
    title: 'Students',
    body: 'Confirm your status and browse benefits from participating merchants.',
    cta: 'Browse benefits',
    href: '/marketplace',
  },
  {
    title: 'Businesses',
    body: 'Offer student benefits with eligibility handled by verification and consent.',
    cta: 'Verify students',
    href: '/partner',
  },
  {
    title: 'Universities',
    body: 'Connect enrollment evidence so your students access the benefits they deserve.',
    cta: 'Connect enrollment',
    href: '/partner#universities',
  },
];

export default function AudiencePaths() {
  return (
    <section aria-labelledby="audience-heading" className="remix-audience mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
      <h2 id="audience-heading" className="max-w-2xl text-balance text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
        Three ways in. One clear check.
      </h2>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {paths.map((path, index) => (
          <div
            key={path.href + path.title}
            className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-7"
          >
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3858bb]">
                0{index + 1} / {path.title}
              </p>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{path.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{path.body}</p>
            </div>
            <Link
              href={path.href}
              className="mt-6 inline-flex min-h-[44px] w-fit items-center rounded-full border-2 border-[#1D4ED8]/30 px-5 text-sm font-bold text-[#1D4ED8] hover:bg-[#1D4ED8]/5"
            >
              {path.cta} →
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
