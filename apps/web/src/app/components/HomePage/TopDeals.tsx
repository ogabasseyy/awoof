'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import TopDeals_1 from '../../../../public/images/TopDeals-1.svg';
import TopDeals_2 from '../../../../public/images/TopDeals-2.svg';
import TopDeals_3 from '../../../../public/images/TopDeals-3.svg';
import TopDeals_4 from '../../../../public/images/TopDeals-4.svg';
import TopDeals_5 from '../../../../public/images/TopDeals-5.svg';
import { ScrollReveal } from '@/components/motion/Reveal';
import { Button } from '@/components/ui/button';

export default function TopDeals() {
  return (
    <section
      id="deals"
      className="flex flex-col justify-center items-center w-full px-4 sm:px-6 lg:px-8 overflow-x-hidden scroll-mt-24 py-8 sm:py-12"
    >
      <ScrollReveal className="w-full max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-slate-900">
            Top deals
          </h2>
          <p className="mt-2 text-slate-600 text-base sm:text-lg max-w-lg">
            A taste of what verified students unlock on Awoof.
          </p>
        </div>
        <Link href="/marketplace">
          <Button
            variant="outline"
            className="rounded-full border-[#1D4ED8]/30 text-[#1D4ED8] hover:bg-[#1D4ED8]/5 font-semibold"
          >
            See all deals
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </ScrollReveal>

      <ScrollReveal
        delay={0.1}
        className="relative mt-8 flex justify-center items-end w-full max-w-6xl min-h-[420px] sm:min-h-[560px] lg:h-[840px] bg-gradient-to-b from-[#5076E0] to-transparent rounded-3xl lg:rounded-[2rem] mx-auto overflow-hidden"
      >
        <Image
          src={TopDeals_1}
          alt="Awoof deals preview"
          className="w-full h-auto max-h-[50vh] sm:max-h-[65vh] lg:max-h-none object-contain object-bottom"
        />
        <Image
          src={TopDeals_2}
          alt=""
          className="absolute left-2 sm:left-4 lg:left-[3.75rem] bottom-[20%] sm:bottom-24 lg:bottom-[21rem] w-[22%] sm:w-[24%] lg:w-auto h-auto"
        />
        <Image
          src={TopDeals_3}
          alt=""
          className="absolute left-2 sm:left-4 lg:left-[3.75rem] bottom-1 lg:bottom-2 w-[22%] sm:w-[24%] lg:w-auto h-auto"
        />
        <Image
          src={TopDeals_4}
          alt=""
          className="absolute right-2 sm:right-4 lg:right-9 bottom-[20%] sm:bottom-24 lg:bottom-[21rem] w-[22%] sm:w-[24%] lg:w-auto h-auto"
        />
        <Image
          src={TopDeals_5}
          alt=""
          className="absolute right-2 sm:right-4 lg:right-9 bottom-1 lg:bottom-3 w-[22%] sm:w-[24%] lg:w-auto h-auto"
        />
      </ScrollReveal>
    </section>
  );
}
