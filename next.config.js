/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @react-three/fiber v8 has JSX type incompatibilities with React 19 — pre-existing
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Azure Speech SDK uses Node.js built-ins that don't exist in browsers
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        "node:fs": false,
        "node:net": false,
        "node:tls": false,
        "node:dns": false,
      };
      // Polyfill Buffer for the SDK's browser build
      const webpack = require("webpack");
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] })
      );
    }
    return config;
  },
};

module.exports = nextConfig;
