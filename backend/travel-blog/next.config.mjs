/** @type {import('next').NextConfig} */
const strapiHost = new URL(
  process.env.NEXT_PUBLIC_STRAPI_URL || 'https://cms.fxnstudio.com'
).hostname;

const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['preview.fxnstudio.com'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: strapiHost },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
  async redirects() {
    return [
      // Travel Resources merged into Travel Tips on 2026-05-02.
      { source: '/category/travel-resources', destination: '/category/travel-tips', permanent: true },
    ];
  },
};

export default nextConfig;
