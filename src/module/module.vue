<template>
    <private-view title="Email">
        <template #navigation>
            <v-list nav>
                <v-list-item to="/email/inbox" :active="$route.name === 'email-inbox'">
                    <v-list-item-icon><v-icon name="inbox" /></v-list-item-icon>
                    <v-list-item-content>Inbox</v-list-item-content>
                </v-list-item>
                <v-list-item to="/email/sent" :active="$route.name === 'email-sent'">
                    <v-list-item-icon><v-icon name="send" /></v-list-item-icon>
                    <v-list-item-content>Sent</v-list-item-content>
                </v-list-item>
                <v-list-item to="/email/compose" :active="$route.name === 'email-compose'">
                    <v-list-item-icon><v-icon name="edit" /></v-list-item-icon>
                    <v-list-item-content>Compose</v-list-item-content>
                </v-list-item>
                <v-divider />
                <v-list-item to="/email/mailbox" :active="$route.name === 'email-imap'">
                    <v-list-item-icon><v-icon name="cloud_sync" /></v-list-item-icon>
                    <v-list-item-content>My mailbox (IMAP)</v-list-item-content>
                </v-list-item>
            </v-list>
        </template>

        <template #actions>
            <v-button to="/email/compose" icon rounded>
                <v-icon name="edit" />
            </v-button>
        </template>

        <router-view />
    </private-view>
</template>
