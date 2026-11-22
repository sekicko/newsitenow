import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    DERIV_WS_URL: process.env.DERIV_WS_URL ?? '',
    SUPABASE_URL: process.env.SUPABASE_URL ?? '',
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  },
  turbopack: { root: process.cwd() },
};

export default nextConfig;
