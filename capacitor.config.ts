import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.arena.githworld',
  appName: 'Gith World RP',
  webDir: 'public',
  server: {
    // После публикации замени адрес на домен своего Render Web Service.
    // url: 'https://YOUR-SERVICE.onrender.com',
    cleartext: false
  },
  android: { allowMixedContent: false }
};

export default config;
