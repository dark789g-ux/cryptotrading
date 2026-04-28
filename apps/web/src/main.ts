import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index'
import { initAuthNavigation } from '@/composables/hooks/useAuth'
import './styles/design-system.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
initAuthNavigation(router)
app.mount('#app')
