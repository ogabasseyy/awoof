import Link from 'next/link';
import Logo from '@/app/components/logo';

const columns = [
  {
    heading: 'Students',
    links: [
      { label: 'Marketplace', href: '/marketplace' },
      { label: 'Help', href: '/help' },
    ],
  },
  {
    heading: 'Partners',
    links: [
      { label: 'Businesses', href: '/partner' },
      { label: 'Universities', href: '/partner#universities' },
      { label: 'Developers', href: '/developers' },
    ],
  },
  {
    heading: 'Trust',
    links: [
      { label: 'Trust center', href: '/trust' },
      { label: 'Contact', href: '/contact' },
    ],
  },
];

export default function PublicFooter() {
  return (
    <footer className="w-full border-t border-slate-200 bg-white px-6 py-12 md:px-12">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 md:grid-cols-4">
        <div>
          <Logo color="blue" width={128} height={34} />
          <p className="mt-4 max-w-sm text-base leading-relaxed text-slate-600">
            Student verification and access to benefits.
          </p>
        </div>
        {columns.map((column) => (
          <nav key={column.heading} aria-label={`Footer: ${column.heading}`}>
            <h2 className="text-lg font-bold text-slate-900">{column.heading}</h2>
            <ul className="mt-4 space-y-3">
              {column.links.map((link) => (
                <li key={link.href + link.label}>
                  <Link href={link.href} className="font-medium text-slate-600 hover:text-[#1D4ED8]">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <p className="mx-auto mt-10 max-w-7xl text-sm text-slate-500">
        © {new Date().getFullYear()} Awoof
      </p>
    </footer>
  );
}
