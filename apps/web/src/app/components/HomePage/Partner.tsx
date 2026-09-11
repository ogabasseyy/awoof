'use client';

import Image from 'next/image';
import Link from 'next/link';
import PartnerImage from '../../../../public/images/PartnerImage.svg';
import { ScrollReveal } from '@/components/motion/Reveal';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

function Partner() {
  return (
    <section className="px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
      <ScrollReveal>
        <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl bg-[#1D4ED8] relative">
          <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                'radial-gradient(circle at 85% 50%, rgba(147,197,253,0.45), transparent 50%)',
            }}
          />
          <div className="relative flex flex-col lg:flex-row items-center justify-between gap-8 px-8 sm:px-12 lg:px-16 py-10 sm:py-12 min-h-[260px]">
            <div className="max-w-md z-10 text-center lg:text-left">
              <h2 className="text-white font-extrabold text-2xl sm:text-3xl md:text-4xl leading-tight tracking-tight text-balance">
                Reach thousands of verified students
              </h2>
              <p className="text-blue-100 text-sm sm:text-base md:text-lg mt-3 mb-6 leading-relaxed">
                Join the network, post deals, and track redemptions from your vendor dashboard.
              </p>
              <Link href="/auth/vendor/register">
                <Button
                  size="lg"
                  className="rounded-full bg-white text-[#1D4ED8] hover:bg-blue-50 font-bold px-7 h-12 transition-transform hover:-translate-y-0.5"
                >
                  Partner with us
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <Image
              src={PartnerImage}
              alt=""
              className="relative lg:absolute right-0 bottom-0 w-36 sm:w-44 lg:w-auto h-auto opacity-95 z-0 pointer-events-none"
            />
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}

export default Partner;
