import { Plus_Jakarta_Sans } from 'next/font/google';

const plusJakarta = Plus_Jakarta_Sans({
    subsets: ['latin'],
    variable: '--font-student',
    display: 'swap',
});

export default function StudentLayout({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={`${plusJakarta.variable} ${plusJakarta.className} antialiased`}
            style={{ fontFamily: 'var(--font-student), system-ui, sans-serif' }}
        >
            {children}
        </div>
    );
}
