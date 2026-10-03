/**
 * Team Email — "Email attachments (download)" display
 * ------------------------------------------------------------------
 * For the list view: a paperclip with the attachment count. Clicking it (not
 * the row) opens a menu with a download link per file, so an attachment is
 * two clicks away from the collection page.
 *
 * Only the junction rows are requested (their id and the parent message id):
 * the files themselves live in a folder no policy can read, and are listed
 * through GET /email/message/:id/attachments when the menu opens.
 */

import { defineDisplay } from '@directus/extensions-sdk';
import DisplayComponent from './display.vue';

export default defineDisplay({
    id: 'email-attachments',
    name: 'Email attachments (download)',
    icon: 'attach_file',
    description: 'Attachment count with a download menu',
    component: DisplayComponent,
    types: ['alias'],
    localTypes: ['m2m'],
    options: null,
    fields: (_options: any, { collection }: { collection: string }) => [
        'id',
        collection === 'emails' ? 'emails_id' : 'inbox_email_id',
    ],
});
