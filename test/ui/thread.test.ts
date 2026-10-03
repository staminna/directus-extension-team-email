// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Thread from '../../src/module/routes/Thread.vue';
import EmailViewer from '../../src/module/components/EmailViewer.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { resetRouter, route } from '../mocks/vue-router';
import { httpError, stubs } from './helpers';

const mountThread = async () => {
    const w = mount(Thread, { global: { stubs: { ...stubs, EmailViewer: true } } });
    await flushPromises();
    return w;
};

describe('Thread', () => {
    beforeEach(() => { resetApi(); resetRouter(); route.params = { id: 't1' }; });
    afterEach(() => { api.defaults.baseURL = ''; });

    it('renders every message of the conversation', async () => {
        api.defaults.baseURL = '/dx/';
        api.get.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'r1', _kind: 'received', from_name: 'Ann', subject: 'Hi',
                        to_addresses: [{ email: 'me@x' }], cc_addresses: [{ name: 'Cc', email: 'c@x' }, { email: 'd@x' }],
                        date_created: '2026-01-01T10:00:00Z', body_html: '<p>x</p>',
                        attachments: [
                            { directus_files_id: { id: 'f 1', filename_download: 'a.pdf' } },
                            { directus_files_id: 'f2' },
                        ],
                    },
                    { id: 's1', _kind: 'sent', from_address: 'me@x', body_text: 'reply' },
                    { id: 's2', _kind: 'sent' },
                ],
            },
        });
        const w = await mountThread();
        expect(api.get).toHaveBeenCalledWith('/email/threads/t1');
        const msgs = w.findAll('article.message');
        expect(msgs).toHaveLength(3);
        expect(msgs[0]!.find('.from strong').text()).toBe('Ann');
        expect(msgs[0]!.find('.kind').text()).toBe('Received');
        expect(msgs[0]!.text()).toContain('to me@x');
        expect(msgs[0]!.text()).toContain('cc Cc, d@x');
        expect(msgs[0]!.find('.date').text()).not.toBe('');
        const links = msgs[0]!.findAll('a.attachment');
        expect(links[0]!.attributes('href')).toBe('/dx/email/message/r1/attachment/f%201?kind=received');
        expect(links[0]!.text()).toContain('a.pdf');
        expect(links[1]!.attributes('href')).toBe('/dx/email/message/r1/attachment/f2?kind=received');

        expect(msgs[1]!.find('.from strong').text()).toBe('me@x');
        expect(msgs[1]!.find('.kind').text()).toBe('Sent');
        expect(msgs[1]!.findAll('.to')).toHaveLength(1);
        expect(msgs[1]!.find('.date').text()).toBe('');
        expect(msgs[1]!.find('.attachments').exists()).toBe(false);
        expect(msgs[2]!.find('.from strong').text()).toBe('—');
        expect(msgs[2]!.find('.subject').text()).toBe('(no subject)');

        const viewer = w.findAllComponents(EmailViewer)[1]!.props();
        expect(viewer).toMatchObject({ messageId: 's1', kind: 'sent', bodyText: 'reply' });
    });

    it('sent attachment urls use kind=sent', async () => {
        api.get.mockResolvedValue({ data: { items: [{ id: 's1', _kind: 'sent', attachments: [{ directus_files_id: { id: 'f' } }] }] } });
        const w = await mountThread();
        expect(w.find('a.attachment').attributes('href')).toBe('/email/message/s1/attachment/f?kind=sent');
    });

    it('shows the loading and empty states', async () => {
        let resolve!: (v: any) => void;
        api.get.mockReturnValue(new Promise(r => { resolve = r; }));
        const w = mount(Thread, { global: { stubs } });
        expect(w.find('.loading').exists()).toBe(true);
        resolve({ data: {} });
        await flushPromises();
        expect(w.find('.empty').text()).toBe('Empty conversation.');
    });

    it('shows errors from the response, the exception, or a default', async () => {
        api.get.mockRejectedValueOnce(httpError(404, { message: 'Thread not found' }));
        let w = await mountThread();
        expect(w.find('.notice-danger').text()).toBe('Thread not found');
        api.get.mockRejectedValueOnce(new Error('net'));
        w = await mountThread();
        expect(w.find('.notice-danger').text()).toBe('net');
        api.get.mockRejectedValueOnce({});
        w = await mountThread();
        expect(w.find('.notice-danger').text()).toBe('Could not load the conversation.');
    });

    it('reloads when the route id changes', async () => {
        api.get.mockResolvedValue({ data: { items: [] } });
        await mountThread();
        route.params = { id: 't2' };
        await flushPromises();
        expect(api.get).toHaveBeenLastCalledWith('/email/threads/t2');
    });
});
