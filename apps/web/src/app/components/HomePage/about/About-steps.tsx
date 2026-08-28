'use client';

import { Stagger, StaggerItem } from '@/components/motion/Reveal';

export default function AboutSteps() {
  const steps = [
    {
      number: 1,
      title: 'Sign up & verify',
      description:
        'Use your school email, pick your university, and confirm with a one-time code.',
    },
    {
      number: 2,
      title: 'Explore student-only deals',
      description:
        'Food, tech, fashion, travel — offers tailored for verified students like you.',
    },
    {
      number: 3,
      title: 'Redeem & enjoy',
      description:
        'Claim on Awoof or at partner sites, show your proof, and save — simple as that.',
    },
  ];

  return (
    <Stagger className="max-w-lg w-full space-y-4">
      {steps.map((step) => (
        <StaggerItem key={step.number}>
          <div className="flex gap-4 p-1">
            <div className="flex-shrink-0">
              <div className="w-11 h-11 rounded-full bg-[#1D4ED8] text-white flex items-center justify-center font-bold text-lg shadow-md shadow-blue-900/15">
                {step.number}
              </div>
            </div>
            <div className="flex-1 rounded-2xl bg-white border border-[#1D4ED8]/10 px-5 py-4 shadow-sm hover:shadow-md hover:border-[#1D4ED8]/20 transition-shadow">
              <h3 className="font-bold text-lg text-slate-900">{step.title}</h3>
              <p className="mt-1 text-slate-600 text-sm leading-relaxed">
                {step.description}
              </p>
            </div>
          </div>
        </StaggerItem>
      ))}
    </Stagger>
  );
}
