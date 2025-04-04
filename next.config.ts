import type { NextConfig } from "next";
import pkg from "./package.json";

const BUILD_MODE = process.env.NEXT_PUBLIC_BUILD_MODE;
const API_PROXY_BASE_URL =
  process.env.API_PROXY_BASE_URL || "https://generativelanguage.googleapis.com";
const GOOGLE_GENERATIVE_AI_API_KEY = process.env
  .GOOGLE_GENERATIVE_AI_API_KEY as string;

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    reactCompiler: false,
  },
  env: {
    NEXT_PUBLIC_VERSION: pkg.version,
  },
};

if (BUILD_MODE === "export") {
  nextConfig.output = "export";
  // Only used for static deployment, the default deployment directory is the root directory
  nextConfig.basePath = "";
  // Statically exporting a Next.js application via `next export` disables API routes and middleware.
  nextConfig.webpack = (config) => {
    config.module.rules.push({
      test: /src\/app\/api/,
      loader: "ignore-loader",
    });
    config.module.rules.push({
      test: /src\/middleware/,
      loader: "ignore-loader",
    });
    return config;
  };
} else if (BUILD_MODE === "standalone") {
  nextConfig.output = "standalone";
} else {
  if (
    GOOGLE_GENERATIVE_AI_API_KEY &&
    !GOOGLE_GENERATIVE_AI_API_KEY.includes(",")
  ) {
    nextConfig.rewrites = async () => {
      return [
        {
          source: "/api/ai/google/v1beta/:path*",
          has: [
            {
              type: "header",
              key: "x-goog-api-key",
              value: "(?<key>.*)",
            },
          ],
          destination: `${API_PROXY_BASE_URL}/v1beta/:path*?key=${GOOGLE_GENERATIVE_AI_API_KEY}`,
        },
      ];
    };
  }
}

export default nextConfig;
