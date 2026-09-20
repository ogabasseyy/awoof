import ScrollToHash from './components/ScrollToHash';
import PublicShell from '@/components/public/PublicShell';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';

export const metadata = buildPublicMetadata(publicPageMetadata['/']);
import Banner from './components/HomePage/banner';
import Cloud from '../../public/images/Cloud.svg';
import Image from 'next/image';
import About from './components/HomePage/About';
import TopDeals from './components/HomePage/TopDeals';
import FAQ from './components/HomePage/FAQ';
import Partner from './components/HomePage/Partner';
import AnimatedTop from './components/HomePage/AnimatedTop';

export default async function Home() {
  return (
    <PublicShell>
      <ScrollToHash />
      <div
        id="hero"
        className="relative min-h-screen bg-gradient-to-b from-[#1D4ED8] via-[#2563EB] to-[#93C5FD]"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 50% at 10% 20%, rgba(255,255,255,0.18), transparent), radial-gradient(ellipse 60% 40% at 90% 10%, rgba(191,219,254,0.35), transparent)',
          }}
        />

        <div className="relative z-30">
          <div className="container w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Banner />
          </div>
        </div>

        <AnimatedTop />

        <Image
          className="absolute bottom-0 left-0 z-0 w-full max-w-none pointer-events-none select-none"
          src={Cloud}
          alt=""
          priority
        />
      </div>
      <About />
      <TopDeals />
      <FAQ />
      <Partner />
    </PublicShell>
  );
}
