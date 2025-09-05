import app from './app';

import {
  Env,
  createLogger,
  DB,
  UserRepository,
  logStartupInfo,
  Cache,
  FeatureControl,
} from '@aiostreams/core';

const logger = createLogger('server');

async function initialiseDatabase() {
  try {
    await DB.getInstance().initialise(Env.DATABASE_URI, []);
  } catch (error) {
    logger.error('Failed to initialise database:', error);
    throw error;
  }
}

async function startAutoPrune() {
  try {
    if (Env.PRUNE_MAX_DAYS < 0) {
      return;
    }
    await UserRepository.pruneUsers(Env.PRUNE_MAX_DAYS);
  } catch {}
  setTimeout(startAutoPrune, Env.PRUNE_INTERVAL * 1000);
}

async function initialiseRedis() {
  if (Env.REDIS_URI) {
    await Cache.testRedisConnection();
  }
}

async function start() {
  try {
    await initialiseDatabase();
    await initialiseRedis();
    FeatureControl.initialise();
    if (Env.PRUNE_MAX_DAYS >= 0) {
      startAutoPrune();
    }
    logStartupInfo();
    const server = app.listen(Env.PORT, (error) => {
      if (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
      }
      logger.info(
        `Server running on port ${Env.PORT}: ${JSON.stringify(server.address())}`
      );
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

async function shutdown() {
  await Cache.close();
  FeatureControl.cleanup();
  await DB.getInstance().close();
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  await shutdown();
  process.exit(0);
});

start().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
