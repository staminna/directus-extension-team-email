/**
 * Lightweight stand-ins for the Directus app's global components. Each one
 * renders its slots and re-emits the events the extension listens to, so
 * tests can drive the real component logic without the Directus app.
 */
import { vi } from 'vitest';
import { defineComponent, h } from 'vue';

const slotOnly = (tag: string, cls: string) =>
    defineComponent({
        name: cls,
        inheritAttrs: false,
        setup(_p, { slots, attrs }) {
            return () => h(tag, { ...attrs, class: [cls, attrs.class] }, slots.default?.());
        },
    });

export const VButton = defineComponent({
    name: 'v-button',
    props: { disabled: Boolean, loading: Boolean, to: String },
    emits: ['click'],
    setup(props, { slots, emit }) {
        return () =>
            h('button', {
                class: 'v-button',
                disabled: props.disabled,
                'data-loading': String(props.loading),
                onClick: (e: Event) => emit('click', e),
            }, slots.default?.());
    },
});

export const VInput = defineComponent({
    name: 'v-input',
    props: { modelValue: null, placeholder: String, type: String, disabled: Boolean },
    emits: ['update:modelValue', 'focus', 'keydown'],
    setup(props, { emit }) {
        return () =>
            h('input', {
                class: 'v-input',
                value: props.modelValue,
                placeholder: props.placeholder,
                type: props.type,
                onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
                onFocus: () => emit('focus'),
                onKeydown: (e: KeyboardEvent) => emit('keydown', e),
            });
    },
});

export const VTextarea = defineComponent({
    name: 'v-textarea',
    props: { modelValue: null },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
        return () =>
            h('textarea', {
                class: 'v-textarea',
                value: props.modelValue,
                onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value),
            });
    },
});

export const VCheckbox = defineComponent({
    name: 'v-checkbox',
    props: { modelValue: Boolean, label: String, disabled: Boolean },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
        return () =>
            h('input', {
                type: 'checkbox',
                class: 'v-checkbox',
                'data-label': props.label,
                checked: props.modelValue,
                onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).checked),
            });
    },
});

export const VNotice = defineComponent({
    name: 'v-notice',
    props: { type: { type: String, default: 'info' } },
    setup(props, { slots }) {
        return () => h('div', { class: ['v-notice', `notice-${props.type}`] }, slots.default?.());
    },
});

export const VIcon = defineComponent({
    name: 'v-icon',
    props: { name: String },
    setup(props) {
        return () => h('i', { class: 'v-icon', 'data-icon': props.name });
    },
});

export const VUpload = defineComponent({
    name: 'v-upload',
    props: { folder: null, multiple: Boolean },
    emits: ['start', 'input'],
    setup() {
        return () => h('div', { class: 'v-upload' });
    },
});

export const RichText = defineComponent({
    name: 'interface-input-rich-text-html',
    props: { value: null, toolbar: Array },
    emits: ['input'],
    setup() {
        return () => h('div', { class: 'rich-text' });
    },
});

/** v-menu: activator slot gets `toggle`; content renders only while open. */
export const VMenu = defineComponent({
    name: 'v-menu',
    props: { modelValue: Boolean },
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
        const toggle = () => emit('update:modelValue', !props.modelValue);
        return () =>
            h('div', { class: 'v-menu' }, [
                slots.activator?.({ toggle }),
                props.modelValue ? h('div', { class: 'v-menu-content' }, slots.default?.()) : null,
            ]);
    },
});

export const PrivateView = defineComponent({
    name: 'private-view',
    props: { title: String },
    setup(_p, { slots }) {
        return () =>
            h('div', { class: 'private-view' }, [
                h('nav', slots.navigation?.()),
                h('div', { class: 'actions' }, slots.actions?.()),
                slots.default?.(),
            ]);
    },
});

export const stubs = {
    'v-button': VButton,
    'v-input': VInput,
    'v-textarea': VTextarea,
    'v-checkbox': VCheckbox,
    'v-notice': VNotice,
    'v-icon': VIcon,
    'v-upload': VUpload,
    'v-menu': VMenu,
    'interface-input-rich-text-html': RichText,
    'private-view': PrivateView,
    'v-progress-circular': slotOnly('div', 'v-progress-circular'),
    'v-chip': slotOnly('span', 'v-chip'),
    'v-list': slotOnly('ul', 'v-list'),
    'v-list-item': slotOnly('li', 'v-list-item'),
    'v-list-item-icon': slotOnly('span', 'v-list-item-icon'),
    'v-list-item-content': slotOnly('span', 'v-list-item-content'),
    'v-divider': slotOnly('hr', 'v-divider'),
    'router-view': slotOnly('div', 'router-view'),
};

/** axios-style rejection. */
export function httpError(status: number, data?: any, message = `HTTP ${status}`) {
    return Object.assign(new Error(message), { response: { status, data } });
}

/** Let the routes' 50 ms "wait for current user" poll fire, then settle. */
export async function settle(ms = 120) {
    await new Promise(r => setTimeout(r, ms));
    await new Promise(r => setTimeout(r, 0));
}

/** happy-dom has no window.confirm; install a controllable one. */
export function mockConfirm(answer = true) {
    const fn = vi.fn(() => answer);
    (window as any).confirm = fn;
    return fn;
}
