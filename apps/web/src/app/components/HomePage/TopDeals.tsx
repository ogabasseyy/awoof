import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import TopDeals_1 from '../../../../public/images/TopDeals-1.svg';
import TopDeals_2 from '../../../../public/images/TopDeals-2.svg';
import TopDeals_3 from '../../../../public/images/TopDeals-3.svg';
import TopDeals_4 from '../../../../public/images/TopDeals-4.svg';
import TopDeals_5 from '../../../../public/images/TopDeals-5.svg';

export default function TopDeals() {
  return (
    <section
      id="deals"
      className="flex w-full flex-col items-center justify-center overflow-x-hidden px-4 py-8 sm:px-6 sm:py-12 lg:px-8"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
            Top deals
          </h2>
          <p className="mt-2 max-w-lg text-base text-slate-600 sm:text-lg">
            A taste of what verified students unlock on Awoof.
          </p>
        </div>
        <Link
          href="/marketplace"
          className="inline-flex min-h-[44px] w-fit items-center gap-2 rounded-full border border-[#1D4ED8]/30 px-5 font-semibold text-[#1D4ED8] hover:bg-[#1D4ED8]/5"
        >
          See all deals
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="relative mx-auto mt-8 flex min-h-[420px] w-full max-w-6xl items-end justify-center overflow-hidden rounded-3xl bg-gradient-to-b from-[#5076E0] to-transparent sm:min-h-[560px] lg:h-[840px] lg:rounded-[2rem]">
        <Image
          src={TopDeals_1}
          alt="Awoof deals preview"
          className="h-auto max-h-[50vh] w-full object-contain object-bottom sm:max-h-[65vh] lg:max-h-none"
        />
        <Image
          src={TopDeals_2}
          alt=""
          className="absolute bottom-[20%] left-2 h-auto w-[22%] sm:bottom-24 sm:left-4 sm:w-[24%] lg:bottom-[21rem] lg:left-[3.75rem] lg:w-auto"
        />
        <Image
          src={TopDeals_3}
          alt=""
          className="absolute bottom-1 left-2 h-auto w-[22%] sm:left-4 sm:w-[24%] lg:bottom-2 lg:left-[3.75rem] lg:w-auto"
        />
        <Image
          src={TopDeals_4}
          alt=""
          className="absolute bottom-[20%] right-2 h-auto w-[22%] sm:bottom-24 sm:right-4 sm:w-[24%] lg:bottom-[21rem] lg:right-9 lg:w-auto"
        />
        <Image
          src={TopDeals_5}
          alt=""
          className="absolute bottom-1 right-2 h-auto w-[22%] sm:bottom-3 sm:right-4 sm:w-[24%] lg:bottom-3 lg:right-9 lg:w-auto"
        />
      </div>
    </section>
  );
}
