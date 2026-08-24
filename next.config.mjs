/** @type {import('next').NextConfig} */

/*
  BUILD_FOR_ELECTRON=1 switches the build to `standalone` output: a self-contained
  server (server.js + traced node_modules) the packaged Electron app can run with
  its own bundled Node - no pnpm, no system Node, no terminal. The web/Vercel
  build stays untouched.
*/
const nextConfig = {
  ...(process.env.BUILD_FOR_ELECTRON ? { output: 'standalone' } : {}),
  images: {
    unoptimized: true,
  },
}

export default nextConfig
