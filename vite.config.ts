import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    // Без этого watcher лезет в src-tauri/target и падает с EBUSY ровно в тот
    // момент, когда cargo пишет туда exe: `pnpm tauri dev` выживал только на
    // тёплом кеше, когда Rust ничего не пересобирал.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
});
