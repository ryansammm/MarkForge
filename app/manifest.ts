import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Morrow — Markdown Workspace',
    short_name: 'Morrow',
    description: 'A focused workspace for connected Markdown notes and documents.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f7f7f5',
    theme_color: '#f7f7f5',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
