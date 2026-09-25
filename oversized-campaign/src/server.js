import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Oversized Bench listening on ${config.appUrl}`);
  if (config.demoMode) {
    console.log('DEMO MODE: no Shopify credentials. Discount codes are fake (DEMO-...) and e-mail links are logged here.');
    console.log(`  Game:  ${config.appUrl}/play`);
    console.log(`  Admin: ${config.appUrl}/admin  (demo admin, local requests only)`);
  }
});
