'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Scrolls to the section indicated by the URL hash when the home page loads
 * (e.g. after navigating from another page to /#faq).
 */
export default function ScrollToHash() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== '/') return;
    const hash = window.location.hash?.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (!/^(A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.hasAttribute('tabindex')) {
        el.setAttribute('tabindex', '-1');
      }
      (el as HTMLElement).focus({ preventScroll: true });
    }
  }, [pathname]);

  return null;
}
