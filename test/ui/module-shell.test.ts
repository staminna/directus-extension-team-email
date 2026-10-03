// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import ModuleShell from '../../src/module/module.vue';
import { stubs } from './helpers';

it('marks the navigation item for the current route as active', () => {
    const w = mount(ModuleShell, { global: { stubs, mocks: { $route: { name: 'email-sent' } } } });
    const items = w.findAll('.v-list-item');
    expect(items).toHaveLength(4);
    expect(items.map(i => i.attributes('active'))).toEqual(['false', 'true', 'false', 'false']);
    expect(w.text()).toContain('My mailbox (IMAP)');
    expect(w.find('.router-view').exists()).toBe(true);
});
