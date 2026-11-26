import nextEnv from "@next/env";
import { defineConfig, env } from "prisma/config";

nextEnv.loadEnvConfig(process.cwd());

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  engine: "classic",
  datasource: {
    // Keep DDL credentials out of the web/runtime process in production.
    // Local development falls back to DATABASE_URL for a single-user setup.
    url: process.env.MIGRATION_DATABASE_URL || env("DATABASE_URL"),
  },
});
