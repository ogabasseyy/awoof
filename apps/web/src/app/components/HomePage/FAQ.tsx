function FAQ() {
  const questions = [
    {
      question: 'Is Awoof free for students?',
      answer:
        'Creating a student account is free. Each participating merchant sets its own offer terms.',
    },
    {
      question: 'What does verification check?',
      answer:
        'That depends on the benefit. A school mailbox check and a current-enrollment check are different things, and your status always says which one passed.',
    },
    {
      question: 'Why is my status pending?',
      answer:
        'Usually an evidence source could not be reached. Nothing is guessed — pending stays pending until a check completes.',
    },
    {
      question: 'Where can I use benefits?',
      answer:
        'At participating merchants in the marketplace. Each benefit states where and how it applies.',
    },
    {
      question: 'I run a business. How do I offer student benefits?',
      answer:
        'Create a vendor account, configure your offer, and let student consent and verification handle eligibility.',
    },
  ];

  return (
    <section
      id="faq"
      className="flex scroll-mt-24 flex-col items-center justify-center px-4 py-16 sm:px-6 sm:py-20"
    >
      <div className="max-w-2xl text-center">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
          Frequently asked
        </h2>
        <p className="mt-3 text-base text-slate-600 sm:text-lg">
          Quick answers for students and partners.
        </p>
      </div>

      <div className="mt-10 w-full max-w-3xl space-y-3">
        {questions.map((item) => (
          <details
            key={item.question}
            className="group rounded-2xl border border-[#1D4ED8]/10 bg-white px-5"
          >
            <summary className="cursor-pointer list-none py-4 font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-4">
                {item.question}
                <span aria-hidden="true" className="text-xl leading-none text-[#1D4ED8] group-open:rotate-45">
                  +
                </span>
              </span>
            </summary>
            <p className="pb-4 leading-relaxed text-slate-600">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default FAQ;
