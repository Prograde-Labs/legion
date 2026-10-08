import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', component: () => import('../chat/ChatView.vue'), meta: { requiresAuth: true } },
  {
    // Approvals badge deep-links to /chat/:id from AppShell badgeClick().
    path: '/chat/:id',
    component: () => import('../chat/ChatView.vue'),
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
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const { isAuthenticated } = useAuth();
  if (to.meta.requiresAuth && !isAuthenticated.value) return '/login';
  return;
});
