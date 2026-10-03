/**
 * Team Email — "Email attachments (download)" interface
 * ------------------------------------------------------------------
 * Lists a message's attachments with a download button per file, and an
 * "open" button for types the browser shows safely (PDF, images, text).
 * Meant for the `attachments` M2M field of inbox_email (and emails).
 *
 * Read-only: it never writes the relation. Files are served by
 * GET /email/message/:id/attachment/:fileId, which checks the caller may read
 * the message — and, for the shared info@ mailbox, that they hold one of
 * EMAIL_SHARED_INBOX_ROLES (Administrativo, Administrator).
 */

import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
    id: 'email-attachments',
    name: 'Email attachments (download)',
    icon: 'attach_file',
    description: 'One-click download for every attachment of an email',
    component: InterfaceComponent,
    types: ['alias'],
    localTypes: ['m2m'],
    group: 'relational',
    relational: true,
    options: null,
});
