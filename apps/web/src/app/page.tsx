import ScrollToHash from './components/ScrollToHash';
import PublicShell from '@/components/public/PublicShell';
import { buildPublicMetadata } from '@/lib/public-metadata';
import { publicPageMetadata } from '@/content/public/page-metadata';
import Banner from './components/HomePage/banner';
import AudiencePaths from './components/HomePage/AudiencePaths';
import About from './components/HomePage/About';
import TopDeals from './components/HomePage/TopDeals';
import TrustStrip from './components/HomePage/TrustStrip';
import FAQ from './components/HomePage/FAQ';
import Partner from './components/HomePage/Partner';

export const metadata = buildPublicMetadata(publicPageMetadata['/']);

export default async function Home() {
  return (
    <PublicShell>
      <ScrollToHash />
      <div
        id="hero"
        className="relative bg-gradient-to-b from-[#1D4ED8] via-[#2563EB] to-[#93C5FD]"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 50% at 10% 20%, rgba(255,255,255,0.18), transparent), radial-gradient(ellipse 60% 40% at 90% 10%, rgba(191,219,254,0.35), transparent)',
          }}
        />
        <div className="relative">
          <Banner />
        </div>
      </div>
      <AudiencePaths />
      <About />
      <TopDeals />
      <TrustStrip />
      <FAQ />
      <Partner />
    </PublicShell>
  );
}
