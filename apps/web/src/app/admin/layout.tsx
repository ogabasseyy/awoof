import { Plus_Jakarta_Sans } from 'next/font/google';

const plusJakarta = Plus_Jakarta_Sans({
    subsets: ['latin'],
    variable: '--font-admin',
    display: 'swap',
});

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={`${plusJakarta.variable} ${plusJakarta.className} antialiased`}
            style={{ fontFamily: 'var(--font-admin), system-ui, sans-serif' }}
        >
            {children}
        </div>
    );
}
