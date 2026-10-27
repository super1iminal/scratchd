import { defineConfig } from 'vitest/config';

process.loadEnvFile('.env.dev'); // tests run against `docker compose up -d`
export default defineConfig({});
