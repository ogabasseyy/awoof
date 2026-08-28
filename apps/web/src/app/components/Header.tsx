'use client';

import React, { useEffect, useState } from 'react';
import Logo from './logo';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Menu, X } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

const navItems = [
  { phrase: 'Home', href: '/#hero' },
  { phrase: 'How It Works', href: '/#how-it-works' },
  { phrase: 'Deals', href: '/#deals' },
  { phrase: 'FAQ', href: '/#faq' },
];

function Header() {
  const pathname = usePathname();
  const { isAuthenticated, user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    setMobileOpen(false);
    if (pathname === '/' && href.includes('#')) {
      const id = href.split('#')[1];
      if (id) {
        e.preventDefault();
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const navLinks = (
    <ul className="flex flex-col md:flex-row gap-1 md:gap-1 lg:gap-2">
      {navItems.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="block text-white/95 font-semibold text-sm md:text-[15px] hover:text-white px-3 py-2 rounded-full hover:bg-white/10 transition-colors"
            onClick={(e) => handleNavClick(e, item.href)}
          >
            {item.phrase}
          </Link>
        </li>
      ))}
    </ul>
  );

  const ctaButtons = (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
      {isAuthenticated ? (
        <>
          <Link
            href={user?.role === 'vendor' ? '/vendor/dashboard' : '/marketplace'}
            onClick={() => setMobileOpen(false)}
          >
            <Button
              size="lg"
              className="w-full sm:w-auto rounded-full bg-white text-[#1D4ED8] hover:bg-blue-50 font-bold px-5 h-11"
            >
              {user?.role === 'vendor' ? 'Dashboard' : 'Marketplace'}
            </Button>
          </Link>
          <Button
            size="lg"
            variant="ghost"
            className="rounded-full px-5 h-11 text-white hover:bg-white/15 font-semibold"
            onClick={() => {
              setMobileOpen(false);
              logout();
            }}
          >
            Logout
          </Button>
        </>
      ) : (
        <>
          <Link href="/auth/student/login" onClick={() => setMobileOpen(false)}>
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto rounded-full border-2 border-white/80 bg-transparent text-white hover:bg-white/15 font-bold px-5 h-11"
            >
              Login
            </Button>
          </Link>
          <Link href="/auth/student/register" onClick={() => setMobileOpen(false)}>
            <Button
              size="lg"
              className="w-full sm:w-auto rounded-full bg-white text-[#1D4ED8] hover:bg-blue-50 font-bold px-5 h-11"
            >
              Sign up
            </Button>
          </Link>
        </>
      )}
    </div>
  );

  return (
    <header
      className={`w-full relative z-50 transition-[background,box-shadow,backdrop-filter] duration-300 ${
        scrolled
          ? 'bg-[#1D4ED8]/85 backdrop-blur-md shadow-lg shadow-blue-900/10'
          : 'bg-transparent'
      }`}
    >
      <nav className="flex items-center justify-between py-3 px-4 sm:py-3.5 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <Link href="/" className="shrink-0">
          <Logo color="white" width={128} height={34} />
        </Link>

        <div className="hidden lg:flex items-center gap-6">
          {navLinks}
          {ctaButtons}
        </div>

        <div className="flex lg:hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/20 rounded-full min-w-[44px] min-h-[44px]"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </Button>
        </div>
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="lg:hidden absolute left-0 right-0 top-full z-50 border-b border-white/15 bg-[#1D4ED8]/95 backdrop-blur-md shadow-xl px-4 py-6"
            initial={reduce ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            <div className="flex flex-col gap-6 max-w-md mx-auto">
              {navLinks}
              {ctaButtons}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

export default Header;
