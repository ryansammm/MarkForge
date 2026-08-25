/** @type {import('next').NextConfig} */

/*
  `standalone` selalu aktif: menghasilkan server mandiri (server.js + node_modules
  hasil tracing) yang dibundel ke dalam exe portable oleh scripts/prepare-electron.
  Deploy Vercel dan `next start` lokal tidak terpengaruh - output standalone adalah
  tambahan, bukan pengganti.
*/
const nextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  images: {
    unoptimized: true,
  },
}

export default nextConfig
