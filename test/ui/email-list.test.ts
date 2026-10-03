// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import EmailList from '../../src/module/components/EmailList.vue';
import { stubs } from './helpers';

const mk = (props: Record<string, any>) => mount(EmailList, { props: { items: [], ...props } as any, global: { stubs } });

describe('EmailList', () => {
    it('shows the loading state', () => {
        expect(mk({ loading: true }).text()).toContain('Loading…');
    });

    it('shows the empty state, also when items is nullish', () => {
        expect(mk({}).text()).toContain('No messages.');
        expect(mk({ items: null }).text()).toContain('No messages.');
    });

    it('renders inbox rows with sender, recipients, cc and actions', async () => {
        const onOpen = vi.fn(), onToggleRead = vi.fn(), onDelete = vi.fn();
        const w = mk({
            showFrom: true, onOpen, onToggleRead, onDelete,
            items: [
                {
                    id: '1', thread_id: 't1', is_read: false, from_name: 'Ann',
                    to_addresses: [{ email: 'a@x' }, { name: 'Bob', email: 'b@x' }],
                    cc_addresses: [{ email: 'c@x' }],
                    subject: 'Hello', body_text: 'line1\n\n   line2', received_at: '2026-01-02T03:04:05Z',
                },
                { id: '2', thread_id: 't2', is_read: true, from_address: 'z@x', to_addresses: [], body_html: 'x'.repeat(200) },
                { id: '3', thread_id: 't3', is_read: true },
            ],
        });
        const rows = w.findAll('.email-row');
        expect(rows).toHaveLength(3);
        expect(rows[0]!.classes()).toContain('unread');
        expect(rows[0]!.find('.addr').text()).toBe('Ann');
        expect(rows[0]!.find('.to-addr').text()).toMatch(/to a@x, Bob\s+· cc c@x/);
        expect(rows[0]!.find('.preview').text()).toBe('line1 line2');
        expect(rows[0]!.find('.date').text()).not.toBe('');
        expect(rows[1]!.find('.addr').text()).toBe('z@x');
        expect(rows[1]!.find('.to-addr').exists()).toBe(false);
        expect(rows[1]!.find('.subject').text()).toBe('(no subject)');
        expect(rows[1]!.find('.preview').text()).toHaveLength(140);
        expect(rows[2]!.find('.addr').text()).toBe('—');
        expect(rows[2]!.find('.date').text()).toBe('');
        expect(rows[0]!.find('[data-icon="mark_email_read"]').exists()).toBe(true);
        expect(rows[1]!.find('[data-icon="mark_email_unread"]').exists()).toBe(true);

        await rows[0]!.trigger('click');
        expect(onOpen).toHaveBeenCalledWith('1', 't1');

        const [toggle, del] = rows[0]!.findAll('.actions .v-button');
        await toggle!.trigger('click');
        expect(onToggleRead).toHaveBeenCalledWith('1', true);
        await del!.trigger('click');
        expect(onDelete).toHaveBeenCalledWith('1');
        expect(onOpen).toHaveBeenCalledTimes(1); // action clicks don't open the row
    });

    it('inbox rows without onDelete show only the read toggle', () => {
        const w = mk({ showFrom: true, items: [{ id: '1', to_addresses: [{ email: 'a@x' }] }] });
        expect(w.findAll('.actions .v-button')).toHaveLength(1);
        expect(w.find('.to-addr').text()).toBe('to a@x');
    });

    it('sent rows show recipients and the delete action', async () => {
        const onDelete = vi.fn();
        const w = mk({ showTo: true, onDelete, items: [{ id: '9', to_addresses: [{ name: 'Z', email: 'z@x' }], sent_at: '2026-01-01T00:00:00Z' }] });
        expect(w.find('.addr').text()).toBe('Z');
        await w.find('.actions .v-button').trigger('click');
        expect(onDelete).toHaveBeenCalledWith('9');
    });

    it('rows without from/to flags and no handlers render no actions and clicks are safe', async () => {
        const w = mk({ items: [{ id: '1', date_created: '2026-01-01T00:00:00Z' }] });
        expect(w.find('.addr').exists()).toBe(false);
        expect(w.find('.actions').exists()).toBe(false);
        await w.find('.email-row').trigger('click');
    });
});
