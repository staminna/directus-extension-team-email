// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import AttInterface from '../../src/interfaces/email-attachments/interface.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { httpError, stubs } from './helpers';

const FILES = [
    { id: 'f1', filename: 'doc.pdf', type: 'application/pdf', filesize: 2048 },
    { id: 'f2', filename: 'data.bin', type: 'application/octet-stream', filesize: null },
];

const mk = (props: Record<string, any>) =>
    mount(AttInterface, { props: { collection: 'inbox_email', field: 'attachments', ...props } as any, global: { stubs } });

describe('email-attachments interface', () => {
    beforeEach(resetApi);

    it('explains that attachments need a saved message', async () => {
        const w = mk({ primaryKey: '+' });
        await flushPromises();
        expect(w.find('.v-notice').text()).toContain('depois de a mensagem ser guardada');
        expect(api.get).not.toHaveBeenCalled();
        expect(mk({}).find('.v-notice').exists()).toBe(true);
    });

    it('lists files with download and preview links', async () => {
        let resolve!: (v: any) => void;
        api.get.mockReturnValue(new Promise(r => { resolve = r; }));
        const w = mk({ primaryKey: 'm1', collection: 'emails' });
        await flushPromises();
        expect(w.findAll('.skeleton')).toHaveLength(3);
        resolve({ data: { data: FILES } });
        await flushPromises();
        expect(api.get).toHaveBeenCalledWith('/email/message/m1/attachments', { params: { kind: 'sent' } });
        const files = w.findAll('.file');
        expect(files).toHaveLength(2);
        const dl = files[0]!.find('a.file-btn');
        expect(dl.attributes('href')).toBe('/email/message/m1/attachment/f1?kind=sent');
        expect(dl.attributes('title')).toBe('Descarregar doc.pdf (2.0 KB)');
        expect(files[0]!.find('.size').text()).toBe('2.0 KB');
        expect(files[0]!.find('a.open-btn').attributes('href')).toBe('/email/message/m1/attachment/f1?kind=sent&inline=1');
        expect(files[1]!.find('a.file-btn').attributes('title')).toBe('Descarregar data.bin');
        expect(files[1]!.find('.size').exists()).toBe(false);
        expect(files[1]!.find('a.open-btn').exists()).toBe(false);
        expect(w.find('.summary').text()).toBe('2 anexos · 2.0 KB');
    });

    it('singular summary without size', async () => {
        api.get.mockResolvedValue({ data: { data: [{ id: 'f', filename: 'a', type: 'text/plain', filesize: null }] } });
        const w = mk({ primaryKey: 1 });
        await flushPromises();
        expect(w.find('.summary').text()).toBe('1 anexo');
    });

    it('empty, forbidden and error states', async () => {
        api.get.mockResolvedValueOnce({ data: { data: [] } });
        let w = mk({ primaryKey: 1 });
        await flushPromises();
        expect(w.find('.empty').text()).toContain('Sem anexos');

        api.get.mockRejectedValueOnce(httpError(403));
        w = mk({ primaryKey: 1 });
        await flushPromises();
        expect(w.find('.notice-warning').text()).toContain('Só o Administrativo');

        api.get.mockRejectedValueOnce(new Error('boom'));
        w = mk({ primaryKey: 1 });
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('boom');

        // reloads when the item changes
        api.get.mockResolvedValueOnce({ data: { data: FILES } });
        await w.setProps({ primaryKey: 2 });
        await flushPromises();
        expect(w.findAll('.file')).toHaveLength(2);
    });
});
