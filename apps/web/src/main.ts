import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index'
import './styles/design-system.css'

const app = createApp(App)
app.use(router)
app.mount('#app')
