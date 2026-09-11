'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { ScrollReveal } from '@/components/motion/Reveal';

function FAQ() {
  const questions = [
    {
      question: 'Is Awoof free to use?',
      answer:
        'Yes — free for students. Sign up, verify once, and access exclusive discounts with no subscription fees.',
    },
    {
      question: 'Where can I use Awoof deals?',
      answer:
        'At partner businesses — restaurants, tech, fashion, travel, and more. Each deal shows where it can be redeemed.',
    },
    {
      question: 'Can I access deals without verifying?',
      answer:
        'No. Verification keeps savings for real students and protects partners who offer student-only pricing.',
    },
    {
      question: 'What kind of businesses can join Awoof?',
      answer:
        'Any business that wants verified student customers — from campus cafés to national brands. Create an account and list deals.',
    },
    {
      question: 'Is there a cost to list deals on Awoof?',
      answer:
        'Basic listing options are available to reach our student community. Premium visibility options help maximize reach when you need them.',
    },
  ];

  return (
    <section
      id="faq"
      className="flex flex-col justify-center items-center px-4 sm:px-6 scroll-mt-24 py-16 sm:py-20"
    >
      <ScrollReveal className="text-center max-w-2xl">
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-slate-900">
          Frequently asked
        </h2>
        <p className="mt-3 text-slate-600 text-base sm:text-lg">
          Quick answers for students and partners.
        </p>
      </ScrollReveal>

      <ScrollReveal delay={0.08} className="w-full max-w-3xl mt-10">
        <Accordion type="single" collapsible className="w-full space-y-3">
          {questions.map((item, index) => (
            <AccordionItem
              key={index}
              value={`item-${index}`}
              className="rounded-2xl border border-[#1D4ED8]/10 bg-white px-5 data-[state=open]:shadow-sm"
            >
              <AccordionTrigger className="text-left font-semibold text-slate-900 hover:no-underline py-4">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-slate-600 pb-4 leading-relaxed">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </ScrollReveal>
    </section>
  );
}

export default FAQ;
