import type { NextConfig } from "next"
import path from "path"

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["reze-engine"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "reze-engine": path.resolve(__dirname, "../engine/src/index.ts"),
    }
    return config
  },
}

export default nextConfig
