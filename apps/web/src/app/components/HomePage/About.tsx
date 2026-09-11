'use client';

import AboutSteps from './about/About-steps';
import AboutScreenshot from './about/About-screenshot';
import { ScrollReveal } from '@/components/motion/Reveal';

function About() {
  return (
    <section
      id="how-it-works"
      className="relative overflow-x-hidden scroll-mt-24 py-16 sm:py-20 lg:py-24"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <ScrollReveal className="max-w-2xl mb-10 sm:mb-14">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-slate-900 text-balance">
            How Awoof works
          </h2>
          <p className="mt-3 text-base sm:text-lg text-slate-600 leading-relaxed max-w-xl">
            Three steps from campus email to real savings — no catch, no subscription.
          </p>
        </ScrollReveal>

        <div className="relative flex flex-col lg:flex-row justify-center items-center gap-10 lg:gap-14">
          <AboutSteps />
          <ScrollReveal delay={0.12}>
            <AboutScreenshot />
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}

export default About;
