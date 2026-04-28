import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index'
import { initAuthNavigation } from './composables/useAuth'
import './styles/design-system.css'

const app = createApp(App)
app.use(router)
initAuthNavigation(router)
app.mount('#app')
