import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const routes = [
  { path: '/', redirect: '/chat' },
  // Task 9 replaces this with the real ChatView — old ConversationsView for now.
  {
    path: '/chat',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    // Approvals badge deep-links to /chat/:id from AppShell badgeClick().
    // TODO(task-9): ChatView replaces this alias.
    path: '/chat/:id',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  { path: '/login', component: () => import('../views/LoginView.vue') },
  {
    path: '/participants',
    component: () => import('../views/ParticipantsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/processes',
    component: () => import('../views/ProcessesView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/processes/:id',
    component: () => import('../views/ProcessesView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/config',
    component: () => import('../views/ConfigView.vue'),
    meta: { requiresAuth: true },
  },
  // Legacy route kept until Task 9 replaces ConversationsView with ChatView.
  {
    path: '/conversations',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/conversations/new',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/conversations/:id',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const { isAuthenticated } = useAuth();
  if (to.meta.requiresAuth && !isAuthenticated.value) return '/login';
  return;
});
