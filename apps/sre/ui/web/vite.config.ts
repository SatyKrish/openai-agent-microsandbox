// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// Builds the page into ../static/app, which the SRE UI serves at /. The page reuses the
// views in ../static (the health board, findings, evidence and trace renderers) as modules.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/static/app/",
  build: { outDir: "../static/app", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { fs: { allow: [".."] }, proxy: { "/api": "http://localhost:8001" } },
});
