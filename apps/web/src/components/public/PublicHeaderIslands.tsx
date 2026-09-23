'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

export type PublicNavItem = { label: string; href: string };

export const publicNavItems: PublicNavItem[] = [
  { label: 'Students', href: '/marketplace' },
  { label: 'Businesses', href: '/partner' },
  { label: 'Universities', href: '/partner#universities' },
  { label: 'Trust', href: '/trust' },
  { label: 'Help', href: '/help' },
];

export function PublicDesktopNav({ items }: { items: PublicNavItem[] }) {
  return (
    <ul className="flex items-center gap-1">
      {items.map((item) => (
        <li key={item.href + item.label}>
          <Link
            href={item.href}
            className="flex min-h-[44px] items-center rounded-full px-4 text-sm font-semibold text-white/95 hover:bg-white/10 hover:text-white"
          >
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function PublicAuthActions() {
  const { isAuthenticated, user, logout } = useAuth();
  if (isAuthenticated) {
    const dashboardHref = user?.role === 'vendor' ? '/vendor/dashboard' : user?.role === 'admin' ? '/admin/dashboard' : '/marketplace';
    const dashboardLabel = user?.role === 'vendor' || user?.role === 'admin' ? 'Dashboard' : 'Marketplace';
    return (
      <div className="flex items-center gap-2">
        <Link
          href={dashboardHref}
          className="inline-flex min-h-[44px] items-center rounded-full bg-white px-5 text-sm font-bold text-[#1D4ED8] hover:bg-blue-50"
        >
          {dashboardLabel}
        </Link>
        <button
          type="button"
          onClick={() => void logout()}
          className="inline-flex min-h-[44px] items-center rounded-full px-4 text-sm font-semibold text-white hover:bg-white/15"
        >
          Logout
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/auth/student/login"
        className="inline-flex min-h-[44px] items-center rounded-full border-2 border-white/80 px-5 text-sm font-bold text-white hover:bg-white/15"
      >
        Login
      </Link>
      <Link
        href="/auth/student/register"
        className="inline-flex min-h-[44px] items-center rounded-full px-5 text-sm font-bold text-[#17261d] hover:brightness-95"
        style={{ background: 'var(--public-accent)' }}
      >
        Sign up
      </Link>
    </div>
  );
}

export function PublicMobileMenu({ items }: { items: PublicNavItem[] }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open ]);

  return (
    <div className="lg:hidden">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="public-mobile-menu"
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-white hover:bg-white/20"
      >
        <span aria-hidden="true" className="text-2xl leading-none">{open ? '✕' : '☰'}</span>
      </button>
      {open && (
        <div id="public-mobile-menu">
          <nav aria-label="Mobile" className="border-t border-white/15 px-4 py-4">
            <ul className="flex flex-col gap-1">
              {items.map((item) => (
                <li key={item.href + item.label}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-xl px-3 py-3 text-base font-semibold text-white hover:bg-white/10"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-white/15 pt-4" onClick={() => setOpen(false)}>
              <PublicAuthActions />
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
