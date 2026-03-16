import path from "path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'out',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-markdown") || id.includes("remark-gfm")) {
            return "vendor-markdown";
          }
          if (id.includes("@radix-ui") || id.includes("lucide-react") || id.includes("class-variance-authority")) {
            return "vendor-ui";
          }
          return;
        },
      },
    },
  },
});
