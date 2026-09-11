import { Plus_Jakarta_Sans } from 'next/font/google';

const plusJakarta = Plus_Jakarta_Sans({
    subsets: ['latin'],
    variable: '--font-vendor',
    display: 'swap',
});

export default function VendorLayout({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={`${plusJakarta.variable} ${plusJakarta.className} antialiased`}
            style={{ fontFamily: 'var(--font-vendor), system-ui, sans-serif' }}
        >
            {children}
        </div>
    );
}
