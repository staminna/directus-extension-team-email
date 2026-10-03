// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import HtmlView from '../../src/interfaces/email-html-view/interface.vue';
import EmailFrame from '../../src/shared/EmailFrame.vue';
import { api } from '../mocks/extensions-sdk';
import { stubs } from './helpers';

const mk = (props: Record<string, any>) =>
    mount(HtmlView, { props: { value: null, ...props } as any, global: { stubs: { ...stubs, EmailFrame: true } } });

describe('email-html-view interface', () => {
    afterEach(() => { api.defaults.baseURL = ''; });

    it('shows a notice for an empty unsaved value', () => {
        for (const pk of [undefined, null, '', '+']) {
            const w = mk({ primaryKey: pk, value: '   ' });
            expect(w.find('.notice-info').text()).toBe('No HTML body.');
            expect(w.findComponent(EmailFrame).exists()).toBe(false);
        }
    });

    it('renders an unsaved value inline', () => {
        const p = mk({ value: '<p>draft</p>', primaryKey: '+' }).findComponent(EmailFrame).props();
        expect(p.src).toBeNull();
        expect(p.srcdoc).toMatch(/^<!doctype html>.*<body><p>draft<\/p><\/body><\/html>$/);
        expect(p.minHeight).toBe(160);
    });

    it('loads a saved message from the body endpoint, kind from the collection', () => {
        api.defaults.baseURL = '/api/';
        let p = mk({ value: 'abcd', primaryKey: 12, collection: 'emails', minHeight: 300 }).findComponent(EmailFrame).props();
        expect(p.src).toBe('/api/email/message/12/body?kind=sent&v=4');
        expect(p.minHeight).toBe(300);
        p = mk({ value: null, primaryKey: 'x y', collection: 'inbox_email' }).findComponent(EmailFrame).props();
        expect(p.src).toBe('/api/email/message/x%20y/body?kind=received&v=0');
        expect(p.srcdoc).toContain('<body></body>');
    });

    it('an explicit kind overrides the collection', () => {
        expect(mk({ value: 'x', primaryKey: 1, collection: 'emails', kind: 'received' }).findComponent(EmailFrame).props('src'))
            .toContain('kind=received');
        expect(mk({ value: 'x', primaryKey: 1, collection: 'inbox_email', kind: 'sent' }).findComponent(EmailFrame).props('src'))
            .toContain('kind=sent');
    });
});
