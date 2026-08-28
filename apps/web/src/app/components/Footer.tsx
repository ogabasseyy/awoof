import { Instagram, Facebook, Twitter, Linkedin } from 'lucide-react';
import Link from 'next/link';
import Logo from './logo';
import Applestore from './HomePage/applestore';
import Googleplaystore from './HomePage/googleplaystore';

export default function Footer() {
  return (
    <footer className="bg-white border-t border-[#1D4ED8]/10 py-14 px-6 md:px-12">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8">
        <div>
          <div className="mb-4">
            <Logo color="blue" width={128} height={34} />
          </div>
          <p className="text-slate-600 text-base leading-relaxed max-w-sm">
            Exclusive discounts on food, tech, and travel — only for verified students.
          </p>
          <div className="flex gap-3 mt-5">
            {[Instagram, Facebook, Twitter, Linkedin].map((Icon, i) => (
              <a
                key={i}
                href="#"
                className="w-10 h-10 rounded-full flex items-center justify-center text-slate-500 hover:text-[#1D4ED8] hover:bg-[#1D4ED8]/8 transition-colors"
                aria-label="Social link"
              >
                <Icon size={18} />
              </a>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-2 scale-90 origin-left opacity-90">
            <Googleplaystore />
            <Applestore />
          </div>
        </div>

        <div className="flex justify-start md:justify-center">
          <div>
            <h3 className="font-bold text-lg text-slate-900 mb-4">Quick links</h3>
            <ul className="flex flex-row flex-wrap gap-x-4 gap-y-2 list-none pl-0 md:flex-col md:space-y-3 md:gap-0">
              {[
                { href: '/#hero', label: 'Home' },
                { href: '/#how-it-works', label: 'How it works' },
                { href: '/#deals', label: 'Top deals' },
                { href: '/marketplace', label: 'Marketplace' },
                { href: '/#faq', label: 'FAQs' },
                { href: '/auth/vendor/register', label: 'Partner with us' },
              ].map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-slate-600 hover:text-[#1D4ED8] transition-colors font-medium"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="rounded-2xl bg-[#1D4ED8] p-7 text-white">
          <h3 className="font-bold text-xl sm:text-2xl leading-tight">
            Don&apos;t miss the next big Awoof
          </h3>
          <p className="text-sm mt-2 mb-5 text-blue-100 leading-relaxed">
            Create a free student account and get deals the moment they drop.
          </p>
          <Link
            href="/auth/student/register"
            className="inline-flex items-center justify-center rounded-full bg-white text-[#1D4ED8] font-bold px-6 py-3 hover:bg-blue-50 transition-colors"
          >
            Sign up free
          </Link>
        </div>
      </div>
    </footer>
  );
}
