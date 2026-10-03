// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import AttDisplay from '../../src/displays/email-attachments/display.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { httpError, stubs } from './helpers';

const mk = (props: Record<string, any>) =>
    mount(AttDisplay, { props: { collection: 'inbox_email', field: 'attachments', ...props } as any, global: { stubs } });

const openMenu = async (w: any) => {
    await w.find('button.clip').trigger('click');
    await flushPromises();
};

describe('email-attachments display', () => {
    beforeEach(resetApi);

    it('shows a dash without attachments', () => {
        expect(mk({ value: null }).find('.none').text()).toBe('—');
        expect(mk({ value: [] }).find('.none').exists()).toBe(true);
    });

    it('shows the count and loads files when opened, once', async () => {
        api.get.mockResolvedValue({ data: { data: [{ id: 'f1', filename: 'a.png', type: 'image/png', filesize: 10 }] } });
        const w = mk({ collection: 'emails', value: [{ id: 1, emails_id: { id: 'm1' } }, { id: 2, emails_id: { id: 'm1' } }] });
        expect(w.find('button.clip').text()).toBe('2');
        expect(w.find('button.clip').attributes('title')).toBe('2 anexos — clique para descarregar');
        expect(api.get).not.toHaveBeenCalled();
        await openMenu(w);
        expect(api.get).toHaveBeenCalledWith('/email/message/m1/attachments', { params: { kind: 'sent' } });
        const row = w.find('a.row');
        expect(row.attributes('href')).toBe('/email/message/m1/attachment/f1?kind=sent');
        expect(row.find('.size').text()).toBe('10 B');
        await row.trigger('click'); // closes the menu
        expect(w.find('.v-menu-content').exists()).toBe(false);
        await openMenu(w);
        expect(api.get).toHaveBeenCalledTimes(1);
        await openMenu(w); // close via toggle
    });

    it('shows the loading state, and the empty list', async () => {
        let resolve!: (v: any) => void;
        api.get.mockReturnValue(new Promise(r => { resolve = r; }));
        const w = mk({ value: [{ inbox_email_id: 'm2' }] });
        expect(w.find('button.clip').attributes('title')).toBe('1 anexo — clique para descarregar');
        await openMenu(w);
        expect(w.find('.state').text()).toBe('A carregar…');
        resolve({ data: { data: [] } });
        await flushPromises();
        expect(api.get).toHaveBeenCalledWith('/email/message/m2/attachments', { params: { kind: 'received' } });
        expect(w.find('.state').text()).toBe('Sem anexos');
    });

    it('forbidden and retryable errors', async () => {
        api.get.mockRejectedValueOnce(httpError(403));
        let w = mk({ value: [{ inbox_email_id: 'm' }] });
        await openMenu(w);
        expect(w.find('.state').text()).toContain('Só Administrativo e Administrador');

        api.get.mockRejectedValueOnce(new Error('down'));
        w = mk({ value: [{ inbox_email_id: 'm' }] });
        await openMenu(w);
        expect(w.find('.state.danger').text()).toBe('down');
        await openMenu(w); // close
        api.get.mockResolvedValueOnce({ data: { data: [{ id: 'f', filename: 'x', type: '', filesize: 1 }] } });
        await openMenu(w); // reopen retries
        expect(w.findAll('a.row')).toHaveLength(1);
    });

    it('resets when the row is recycled for another message', async () => {
        api.get.mockResolvedValue({ data: { data: [{ id: 'f', filename: 'x', type: '', filesize: 1 }] } });
        const w = mk({ value: [{ inbox_email_id: 'm1' }] });
        await openMenu(w);
        await w.setProps({ value: [{ inbox_email_id: 'm2' }] });
        await flushPromises();
        expect(w.find('.state').exists()).toBe(false);
        expect(w.findAll('a.row')).toHaveLength(0);
        await openMenu(w);
        await openMenu(w);
        expect(api.get).toHaveBeenLastCalledWith('/email/message/m2/attachments', expect.anything());
    });

    it('does not load without a message id', async () => {
        const w = mk({ value: [{ id: 1 }] });
        await openMenu(w);
        expect(api.get).not.toHaveBeenCalled();
    });
});
