import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Lora } from 'next/font/google'

import { ThemeProvider } from '@/components/theme-switcher'
import { PwaRuntime } from '@/components/pwa-install'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const lora = Lora({ subsets: ['latin'], variable: '--font-lora' })

export const metadata: Metadata = {
  title: 'MarkForge',
  description: 'A focused workspace for connected Markdown notes and documents.',
  generator: 'v0.app',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon-192.png', apple: '/apple-icon.png' },
  applicationName: 'MarkForge',
  authors: [{ name: 'XYKS' }],
  appleWebApp: {
    capable: true,
    title: 'MarkForge',
    statusBarStyle: 'default',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#111111' },
    { media: '(prefers-color-scheme: dark)', color: '#111111' },
  ],
  userScalable: true,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`bg-background ${geist.variable} ${lora.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
        {/*
          Registers the service worker and captures `beforeinstallprompt` for every
          route. It renders nothing — the button itself lives in the workspace header,
          because a floating one landed on top of the controls already there.
        */}
        <PwaRuntime />
        {process.env.NODE_ENV === 'production' && (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        )}
      </body>
    </html>
  )
}
