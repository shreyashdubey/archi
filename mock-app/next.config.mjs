/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compile the workspace packages (they ship TS source, not built JS).
  transpilePackages: ['@mock/ui', '@mock/data', '@mock/instrumentation', '@mock/telemetry'],
}

export default nextConfig
