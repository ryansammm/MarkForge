/** @type {import('next').NextConfig} */

/*
  `standalone` selalu aktif: menghasilkan server mandiri (server.js + node_modules
  hasil tracing) yang dibundel ke dalam exe portable oleh scripts/build-portable.mjs.
  Deploy Vercel dan `next start` lokal tidak terpengaruh - output standalone adalah
  tambahan, bukan pengganti.
*/
const nextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  images: {
    unoptimized: true,
  },
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  devIndicators: {
    // Move the on-screen dev indicator out of the way of the workspace's
    // status strip, which sits in the same bottom-left corner.
    position: 'bottom-right',
  },
}

export default nextConfig
