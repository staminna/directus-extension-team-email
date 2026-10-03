import { defineModule } from '@directus/extensions-sdk';
import ModuleShell from './module.vue';
import Inbox from './routes/Inbox.vue';
import Sent from './routes/Sent.vue';
import Compose from './routes/Compose.vue';
import Thread from './routes/Thread.vue';
import ImapSettings from './routes/ImapSettings.vue';

export default defineModule({
    id: 'email',
    name: 'Email',
    icon: 'mail',
    routes: [
        {
            path: '',
            redirect: '/email/inbox',
        },
        {
            name: 'email-shell',
            path: '',
            component: ModuleShell,
            children: [
                { name: 'email-inbox',   path: 'inbox',     component: Inbox   },
                { name: 'email-sent',    path: 'sent',      component: Sent    },
                { name: 'email-compose', path: 'compose',   component: Compose },
                { name: 'email-thread',  path: 'thread/:id', component: Thread },
                { name: 'email-imap',    path: 'mailbox',   component: ImapSettings },
            ],
        },
    ],
});
