import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: { colors: { kora: { ink: "#22231f", moss: "#52624d", cream: "#f5f5f0", lime: "#d9ec79" } } } },
  plugins: [],
} satisfies Config;
