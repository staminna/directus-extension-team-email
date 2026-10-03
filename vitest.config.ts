import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            '@directus/extensions-sdk': fileURLToPath(new URL('./test/mocks/extensions-sdk.ts', import.meta.url)),
            'vue-router': fileURLToPath(new URL('./test/mocks/vue-router.ts', import.meta.url)),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        restoreMocks: true,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,vue}', 'scripts/**/*.mjs'],
            exclude: ['src/**/*.d.ts'],
            reporter: ['text', 'lcov', 'json-summary'],
            thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
        },
    },
});
