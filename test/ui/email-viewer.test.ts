// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import EmailViewer from '../../src/module/components/EmailViewer.vue';
import EmailFrame from '../../src/shared/EmailFrame.vue';
import { api } from '../mocks/extensions-sdk';
import { stubs } from './helpers';

const frameProps = (props: Record<string, any>) =>
    mount(EmailViewer, { props, global: { stubs: { ...stubs, EmailFrame: true } } }).findComponent(EmailFrame).props();

describe('EmailViewer', () => {
    afterEach(() => { api.defaults.baseURL = ''; });

    it('points at the body endpoint for received messages', () => {
        const p = frameProps({ messageId: 'a b', kind: 'received' });
        expect(p.src).toBe('/email/message/a%20b/body?kind=received');
        expect(p.minHeight).toBe(120);
    });

    it('uses the api base url and sent kind', () => {
        api.defaults.baseURL = 'https://x.test/directus/';
        expect(frameProps({ messageId: '7', kind: 'sent' }).src).toBe('https://x.test/directus/email/message/7/body?kind=sent');
    });

    it('falls back to inline html when there is no id', () => {
        const p = frameProps({ bodyHtml: '<b>hi</b>' });
        expect(p.src).toBeNull();
        expect(p.srcdoc).toBe('<b>hi</b>');
    });

    it('escapes plain text into a pre block', () => {
        expect(frameProps({ bodyText: 'a < b & c > d' }).srcdoc).toContain('a &lt; b &amp; c &gt; d</pre>');
        expect(frameProps({}).srcdoc).toMatch(/<pre[^>]*><\/pre>$/);
    });
});
