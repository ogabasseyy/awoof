import Link from 'next/link';
import Logo from '@/app/components/logo';
import { PublicAuthActions, PublicDesktopNav, PublicMobileMenu, publicNavItems } from './PublicHeaderIslands';

export default function PublicHeader() {
  return (
    <header className="w-full" style={{ background: 'var(--public-blue)' }}>
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="shrink-0" aria-label="Awoof home">
          <Logo color="white" width={128} height={34} />
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-4 lg:flex">
          <PublicDesktopNav items={publicNavItems} />
          <PublicAuthActions />
        </nav>
        <PublicMobileMenu items={publicNavItems} />
      </div>
    </header>
  );
}
