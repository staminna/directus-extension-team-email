// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import moduleDef from '../../src/module/index';
import htmlView from '../../src/interfaces/email-html-view/index';
import attInterface from '../../src/interfaces/email-attachments/index';
import attDisplay from '../../src/displays/email-attachments/index';

describe('extension definitions', () => {
    it('module registers the shell and its child routes', () => {
        expect(moduleDef.id).toBe('email');
        const [redirect, shell] = moduleDef.routes as any[];
        expect(redirect).toEqual({ path: '', redirect: '/email/inbox' });
        expect(shell.children.map((c: any) => c.name)).toEqual([
            'email-inbox', 'email-sent', 'email-compose', 'email-thread', 'email-imap',
        ]);
        for (const c of shell.children) expect(c.component).toBeTruthy();
    });

    it('html view interface accepts text fields and exposes kind/minHeight options', () => {
        expect(htmlView.id).toBe('email-html-view');
        expect(htmlView.types).toEqual(['text', 'string']);
        expect((htmlView.options as any[]).map(o => o.field)).toEqual(['kind', 'minHeight']);
        expect(htmlView.component).toBeTruthy();
    });

    it('attachments interface is a read-only m2m alias', () => {
        expect(attInterface).toMatchObject({ id: 'email-attachments', types: ['alias'], localTypes: ['m2m'], relational: true });
    });

    it('attachments display requests the junction fk matching the collection', () => {
        const fields = attDisplay.fields as any;
        expect(fields({}, { collection: 'emails' })).toEqual(['id', 'emails_id']);
        expect(fields({}, { collection: 'inbox_email' })).toEqual(['id', 'inbox_email_id']);
    });
});
