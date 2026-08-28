import { Plus_Jakarta_Sans } from 'next/font/google'
import './globals.css'
import { AuthProvider } from '@/contexts/AuthContext'
import { ConfirmProvider } from '@/components/ui/ConfirmDialog'
import { AppToaster } from '@/components/ui/AppToaster'

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

export const metadata = {
  title: 'Awoof - Student Discounts',
  description: 'Get exclusive student discounts and save on your favorite products',
  openGraph: {
    title: 'Awoof - Student Discounts',
    description: 'Get exclusive student discounts and save on your favorite products',
    url: 'https://awoof.tech',
    siteName: 'Awoof',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Awoof - Student Discounts',
    description: 'Get exclusive student discounts and save on your favorite products',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${plusJakarta.variable} ${plusJakarta.className} antialiased`}>
        <AuthProvider>
          <ConfirmProvider>
            {children}
            <AppToaster />
          </ConfirmProvider>
        </AuthProvider>
      </body>
    </html>
  )
}