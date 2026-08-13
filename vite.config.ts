import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// Pages serves the app from https://<user>.github.io/<repo>/, so asset URLs
// need that prefix; everywhere else (dev, preview, custom domains) uses root.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS
    ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? ''}/`
    : '/',
  plugins: [react()],
});
