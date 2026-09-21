function AboutScreenshot() {
  return (
    <div className="w-full max-w-lg">
      <div
        role="img"
        aria-label="Illustrative sample: a student verification status card showing one confirmed and one pending check"
        className="rounded-3xl bg-white p-7 shadow-sm ring-1 ring-[#1D4ED8]/10"
      >
        <div className="flex items-center justify-between">
          <p className="text-lg font-extrabold tracking-tight text-slate-900">Your verification</p>
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
            Illustrative sample
          </p>
        </div>
        <dl className="mt-5 space-y-4">
          <div className="flex items-center justify-between rounded-2xl bg-emerald-50 px-4 py-3">
            <dt className="text-sm font-semibold text-slate-700">School mailbox</dt>
            <dd className="text-sm font-bold text-emerald-700">Confirmed ✓</dd>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-amber-50 px-4 py-3">
            <dt className="text-sm font-semibold text-slate-700">Current enrollment</dt>
            <dd className="text-sm font-bold text-amber-700">Pending ◷</dd>
          </div>
        </dl>
        <p className="mt-5 text-sm leading-relaxed text-slate-600">
          Two separate checks, two separate answers. A pending check never
          upgrades itself — and it never blocks what is already confirmed.
        </p>
      </div>
      <p className="mt-3 text-center text-xs text-slate-500">
        Sample states for illustration — not your account.
      </p>
    </div>
  );
}

export default AboutScreenshot;
