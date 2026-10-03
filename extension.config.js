/**
 * Build configuration for the Directus extensions SDK.
 *
 * The API bundle normally inlines every dependency. `imapflow` and
 * `postal-mime` stay external instead: imapflow pulls in pino and socket
 * code that does not survive being flattened into one file, and Node resolves
 * both at runtime from this package's own node_modules (they are regular
 * `dependencies`, installed next to dist/). The app bundle is unaffected.
 */
const RUNTIME_EXTERNALS = new Set(['imapflow', 'postal-mime']);

export default {
    plugins: [
        {
            name: 'team-email-runtime-externals',
            resolveId(source) {
                if (RUNTIME_EXTERNALS.has(source)) return { id: source, external: true };
                return null;
            },
        },
    ],
};
