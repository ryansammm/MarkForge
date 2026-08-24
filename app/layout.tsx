import { Analytics } from '@vercel/analytics/next'
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
  title: 'Morrow — Markdown Workspace',
  description: 'A focused workspace for connected Markdown notes and documents.',
  generator: 'v0.app',
  manifest: '/manifest.webmanifest',
  applicationName: 'Morrow',
  appleWebApp: {
    capable: true,
    title: 'Morrow',
    statusBarStyle: 'default',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#181a18' },
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
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
