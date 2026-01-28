import type { NextConfig } from "next";
import { withAmplifyHostingAdapter } from "@aws-amplify/adapter-nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withAmplifyHostingAdapter(nextConfig);
