import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone",
  // Ensure axios is properly resolved
  serverExternalPackages: ['axios'],
  // The dedicated local HTTPS browser fixture reverse-proxies Next as this
  // loopback-only hostname. It is required for dev asset/HMR requests; it
  // neither trusts certificates nor permits a production API origin.
  allowedDevOrigins: ['app.awoof.test'],
};

export default nextConfig;
