// -----------------------------------------------------------------------------
// Entry point of the Yeelight external integration.
//
// Only the wiring lives here: build the SDK instance, register every handler
// (src/app.js, BEFORE connect()), then connect. The SDK handles the connection
// to Gladys, its authentication and its reconnection.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const gladys = new GladysIntegration();
const app = createApp(gladys);

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await app.shutdown();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Yeelight integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
