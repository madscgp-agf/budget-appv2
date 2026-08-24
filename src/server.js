import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Budget app listening on ${config.appUrl}`);
  if (!config.google.enabled) {
    console.log('Google sign-in is off: set GOOGLE_CLIENT_ID in .env to turn it on.');
  }
});
