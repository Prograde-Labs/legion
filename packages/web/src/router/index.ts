import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const routes = [
  { path: '/login', component: () => import('../views/LoginView.vue') },
  { path: '/', redirect: '/participants' },
  {
    path: '/participants',
    component: () => import('../views/ParticipantsView.vue'),
    meta: { requiresAuth: true },
  },
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
  {
    path: '/events',
    component: () => import('../views/EventStreamView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/config',
    component: () => import('../views/ConfigView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/config/credentials',
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
