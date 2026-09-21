import Link from 'next/link';
import { ArrowUpRight, Coffee, Command, Sparkle } from 'lucide-react';
import Logo from '../logo';

export default function Banner() {
  return (
    <div className="remix-hero">
      <p className="remix-eyebrow">Your student chapter. Turned up.</p>
      <h1>Student verification.<br /><em>With more in it.</em></h1>
      <p className="remix-lead">Big ideas. Everyday essentials. A little more possibility.<br className="hidden sm:block" /> Awoof connects student verification to your next advantage.</p>
      <div className="remix-actions">
        <Link href="/marketplace" className="remix-button remix-primary">Find student benefits <ArrowUpRight size={20} aria-hidden="true" /></Link>
        <Link href="#how-it-works" className="remix-button">How verification works <span aria-hidden="true">→</span></Link>
      </div>
      <div className="remix-stage" role="img" aria-label="Illustrative student pass and benefit categories">
        <div className="remix-mini remix-food">
          <p className="remix-eyebrow">The study break</p>
          <Coffee className="remix-sketch" aria-hidden="true" strokeWidth={1.2} />
          <p className="remix-mini-title">Good fuel.<br />Great ideas.</p>
          <small>Food &amp; everyday essentials</small>
        </div>
        <div className="remix-pass">
          <div className="remix-pass-header"><Logo color="blue" width={106} height={32} /><span>Illustrative sample</span></div>
          <p className="remix-pass-title">Made for<br /><em>what&apos;s next.</em></p>
          <div className="remix-pass-bottom"><span>Your student chapter</span><ArrowUpRight size={42} strokeWidth={1} aria-hidden="true" /></div>
          <dl className="remix-status"><div><dt>School account</dt><dd>Confirmed</dd></div><div><dt>Current enrollment</dt><dd>Pending</dd></div></dl>
        </div>
        <div className="remix-mini remix-tech">
          <p className="remix-eyebrow">The next big thing</p>
          <Command className="remix-sketch" aria-hidden="true" strokeWidth={1.2} />
          <p className="remix-mini-title">More power<br />to your plans.</p>
          <small>Tech &amp; learning</small>
        </div>
        <Sparkle className="remix-star" size={65} strokeWidth={1} aria-hidden="true" />
      </div>
      <p className="remix-note">Sample states and categories for illustration — not your account or live offers.</p>
    </div>
  );
}
