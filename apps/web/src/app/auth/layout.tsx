import { Plus_Jakarta_Sans } from 'next/font/google';

const plusJakarta = Plus_Jakarta_Sans({
    subsets: ['latin'],
    variable: '--font-auth',
    display: 'swap',
});

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={`${plusJakarta.variable} ${plusJakarta.className} antialiased`}
            style={{ fontFamily: 'var(--font-auth), system-ui, sans-serif' }}
        >
            {children}
        </div>
    );
}
