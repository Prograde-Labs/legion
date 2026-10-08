import './assets/style.css';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router/index.js';
import { useTheme } from './theme/useTheme.js';

useTheme().initTheme();

createApp(App).use(router).mount('#app');
