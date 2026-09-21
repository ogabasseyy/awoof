import Image from 'next/image';
import Link from 'next/link';
import PartnerImage from '../../../../public/images/PartnerImage.svg';
import { ArrowRight } from 'lucide-react';

function Partner() {
  return (
    <section className="px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-[#1D4ED8]">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(circle at 85% 50%, rgba(147,197,253,0.45), transparent 50%)',
          }}
        />
        <div className="relative flex min-h-[260px] flex-col items-center justify-between gap-8 px-8 py-10 sm:px-12 sm:py-12 lg:flex-row lg:px-16">
          <div className="z-10 max-w-md text-center lg:text-left">
            <h2 className="text-balance text-2xl font-extrabold leading-tight tracking-tight text-white sm:text-3xl md:text-4xl">
              Reach verified students
            </h2>
            <p className="mb-6 mt-3 text-sm leading-relaxed text-blue-100 sm:text-base md:text-lg">
              Offer student benefits with eligibility handled: students consent,
              Awoof verifies, and your business defines the benefit.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link
                href="/auth/vendor/register"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-7 font-bold text-[#1D4ED8] hover:bg-blue-50"
              >
                Partner with us
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/partner"
                className="inline-flex h-12 items-center justify-center rounded-full border-2 border-white/60 px-7 font-bold text-white hover:bg-white/10"
              >
                How partnering works
              </Link>
            </div>
          </div>
          <Image
            src={PartnerImage}
            alt=""
            className="pointer-events-none relative bottom-0 right-0 z-0 h-auto w-36 opacity-95 sm:w-44 lg:absolute lg:w-auto"
          />
        </div>
      </div>
    </section>
  );
}

export default Partner;
