#!/usr/bin/env node
// Team Email — automatic, additive schema install over the Directus REST API.
//
// Reads schema/schema.json (a Directus snapshot that contains ONLY this
// extension's collections) and creates whatever is missing: collections, then
// fields, then relations. It never updates or deletes anything, so it is safe
// to run against a populated project and to re-run.
//
// The Directus API cannot create CHECK constraints or plain indexes, so this
// leaves out three checks (inbox_email.source, email_imap_accounts.port and
// .last_sync_status) and idx_email_imap_accounts_active. The extension works
// without them; on PostgreSQL, schema/install.sql adds them.
//
// Do not feed schema.json to `directus schema apply` or POST /schema/apply on an
// existing project: a snapshot describes the whole schema, so everything not in
// it would be scheduled for deletion.
//
// Usage:
//   DIRECTUS_URL=https://cms.example.com DIRECTUS_TOKEN=<admin static token> \
//     node scripts/install-schema.mjs [--dry-run]

import { readFileSync } from 'node:fs';

const url = (process.env.DIRECTUS_URL ?? '').replace(/\/+$/, '');
const token = process.env.DIRECTUS_TOKEN ?? '';
const dryRun = process.argv.includes('--dry-run');

if (!url || !token) {
    console.error('Set DIRECTUS_URL and DIRECTUS_TOKEN (an admin token).');
    process.exit(1);
}

const snapshot = JSON.parse(readFileSync(new URL('../schema/schema.json', import.meta.url), 'utf8'));

async function api(method, path, body) {
    const res = await fetch(url + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 403) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text).data : null;
}

// Foreign keys are created by the relation, not by the field.
function fieldPayload({ field, type, meta, schema }) {
    const s = schema ? { ...schema } : schema;
    if (s) for (const k of ['table', 'foreign_key_table', 'foreign_key_column', 'foreign_key_schema', 'constraint_name']) delete s[k];
    const m = meta ? { ...meta } : meta;
    if (m) delete m.collection;
    return { field, type, meta: m, schema: s };
}

const existing = new Set(((await api('GET', '/collections')) ?? []).map(c => c.collection));
const log = msg => console.log((dryRun ? '[dry-run] ' : '') + msg);
let created = 0;

for (const col of snapshot.collections) {
    const fields = snapshot.fields.filter(f => f.collection === col.collection);
    if (!existing.has(col.collection)) {
        log(`create collection ${col.collection} (${fields.length} fields)`);
        if (!dryRun) await api('POST', '/collections', {
            collection: col.collection,
            meta: col.meta,
            schema: col.schema ?? {},
            fields: fields.map(fieldPayload),
        });
        created++;
        continue;
    }
    const have = new Set(((await api('GET', `/fields/${col.collection}`)) ?? []).map(f => f.field));
    for (const f of fields) {
        if (have.has(f.field)) continue;
        log(`add field ${col.collection}.${f.field}`);
        if (!dryRun) await api('POST', `/fields/${col.collection}`, fieldPayload(f));
        created++;
    }
}

for (const rel of snapshot.relations) {
    if (!dryRun && await api('GET', `/relations/${rel.collection}/${rel.field}`)) continue;
    if (dryRun && existing.has(rel.collection)) continue;
    log(`create relation ${rel.collection}.${rel.field} → ${rel.related_collection ?? '(any)'}`);
    if (!dryRun) {
        const meta = rel.meta ? { ...rel.meta } : rel.meta;
        await api('POST', '/relations', {
            collection: rel.collection,
            field: rel.field,
            related_collection: rel.related_collection,
            meta,
            schema: rel.schema ? { on_delete: rel.schema.on_delete, on_update: rel.schema.on_update } : undefined,
        });
    }
    created++;
}

console.log(created ? `${dryRun ? 'Would create' : 'Created'} ${created} item(s).` : 'Schema already up to date.');
console.log('Permissions are not granted by this script — see the README.');
