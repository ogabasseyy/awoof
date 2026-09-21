import ScrollToHash from './components/ScrollToHash';
import '@/styles/remix.css';
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
      <div id="hero" className="remix-home-hero"><Banner /></div>
      <div className="remix-band">Campus energy. Everyday possibilities. A very Awoof idea.</div>
      <AudiencePaths />
      <About />
      <TopDeals />
      <TrustStrip />
      <FAQ />
      <Partner />
    </PublicShell>
  );
}
