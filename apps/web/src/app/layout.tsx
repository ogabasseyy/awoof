import { Inter } from 'next/font/google'
import './globals.css'
import { AuthProvider } from '@/contexts/AuthContext'

const inter = Inter({ subsets: ['latin'] })

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
      <body className={inter.className}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  )
}