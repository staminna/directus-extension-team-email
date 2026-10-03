/**
 * Team Email — "Email HTML (rendered)" interface
 * ------------------------------------------------------------------
 * Shows an email body the way a mail client does: the HTML is rendered in a
 * sandboxed frame that grows to the message's full height, with images and
 * layout intact, instead of as markup or through the WYSIWYG editor (which
 * normalizes real email HTML on save).
 *
 * For a saved message the frame loads GET /email/message/:id/body, the same
 * document the module's conversation view uses: it carries a Content-Security-
 * Policy written for mail (images from anywhere, no scripts), so remote images
 * render. For an unsaved item it falls back to the raw value.
 *
 * Display only: the stored HTML is never touched. Edit it, if ever needed,
 * through the API or by switching the field to the Code interface.
 */

import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
    id: 'email-html-view',
    name: 'Email HTML (rendered)',
    icon: 'mark_email_read',
    description: 'Render an email body like a mail client, at its full height',
    component: InterfaceComponent,
    types: ['text', 'string'],
    group: 'standard',
    options: [
        {
            field: 'kind',
            name: 'Message kind',
            type: 'string',
            meta: {
                width: 'half',
                interface: 'select-dropdown',
                options: {
                    choices: [
                        { text: 'Auto (by collection)', value: 'auto' },
                        { text: 'Received (inbox_email)', value: 'received' },
                        { text: 'Sent (emails)', value: 'sent' },
                    ],
                },
                note: 'Which message store the body is served from',
            },
            schema: { default_value: 'auto' },
        },
        {
            field: 'minHeight',
            name: 'Minimum height (px)',
            type: 'integer',
            meta: {
                width: 'half',
                interface: 'input',
                options: { min: 60, step: 20 },
                note: 'Shown while the message loads; the frame then grows to fit',
            },
            schema: { default_value: 160 },
        },
    ],
});
