/**
 * /favicon.ico → the project's favicon
 * ------------------------------------------------------------------
 * Browsers ask for /favicon.ico on every page load; Directus serves its icon
 * under /admin only, so the root request 404s and shows up in the console.
 * This redirects it to the favicon set in Project Settings (public asset),
 * falling back to Directus' own /admin/favicon.ico.
 */

import { defineHook } from '@directus/extensions-sdk';

const TTL_MS = 5 * 60_000;

export default defineHook(({ init }, { database, logger }) => {
    let cached: { at: number; url: string } | null = null;

    async function target(): Promise<string> {
        if (cached && Date.now() - cached.at < TTL_MS) return cached.url;
        let url = '/admin/favicon.ico';
        try {
            const row = await database('directus_settings').select('public_favicon').first();
            if (row?.public_favicon) url = `/assets/${encodeURIComponent(String(row.public_favicon))}`;
        } catch (err) {
            logger.warn({ err }, 'favicon: could not read project settings');
        }
        cached = { at: Date.now(), url };
        return url;
    }

    init('routes.before', ({ app }: any) => {
        app.get('/favicon.ico', async (_req: any, res: any) => {
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.redirect(302, await target());
        });
    });
});
