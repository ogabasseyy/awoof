export default function AboutSteps() {
  const steps = [
    {
      number: 1,
      title: 'Connect your school account',
      description:
        'Start with your school email. Proving you can access a school mailbox is the first step — not proof you are currently enrolled.',
    },
    {
      number: 2,
      title: 'Confirm current enrollment',
      description:
        'Current student status needs an approved evidence source. When it cannot be reached, your status stays pending — never guessed.',
    },
    {
      number: 3,
      title: 'Merchants apply the benefit',
      description:
        'When eligibility is confirmed, participating merchants decide and apply their own student benefit. Offer terms still apply.',
    },
  ];

  return (
    <ol className="w-full max-w-lg space-y-4">
      {steps.map((step) => (
        <li key={step.number} className="flex gap-4 p-1">
          <div className="flex-shrink-0">
            <div
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1D4ED8] text-lg font-bold text-white"
            >
              {step.number}
            </div>
          </div>
          <div className="flex-1 rounded-2xl border border-[#1D4ED8]/10 bg-white px-5 py-4">
            <h3 className="text-lg font-bold text-slate-900">{step.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{step.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
