import AboutSteps from './about/About-steps';
import AboutScreenshot from './about/About-screenshot';

function About() {
  return (
    <section
      id="how-it-works"
      className="relative scroll-mt-24 overflow-x-hidden py-16 sm:py-20 lg:py-24"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-10 max-w-2xl sm:mb-14">
          <h2 className="text-balance text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
            How verification works
          </h2>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
            Three separate checks, explained honestly — including what happens
            when a check cannot complete.
          </p>
        </div>

        <div className="relative flex flex-col items-center justify-center gap-10 lg:flex-row lg:gap-14">
          <AboutSteps />
          <AboutScreenshot />
        </div>
      </div>
    </section>
  );
}

export default About;
