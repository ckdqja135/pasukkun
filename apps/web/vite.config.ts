import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  server: {
    port: 5273,
    // 개발 중에도 운영과 같이 동일 출처의 /api 로 호출한다.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { sourcemap: false },
  test: { include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'] },
});
