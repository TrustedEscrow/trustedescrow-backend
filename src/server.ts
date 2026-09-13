import { buildApp } from './app.js';
import { SorobanChain } from './chain/soroban.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { SecretBox } from './lib/crypto.js';
import { createMailer } from './notifications/mailer.js';
import { LocalBlobStorage } from './storage/blob-storage.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const app = await buildApp({
  config,
  db,
  chain: new SorobanChain(config.SOROBAN_RPC_URL, config.STELLAR_NETWORK_PASSPHRASE),
  mailer: createMailer(config),
  storage: new LocalBlobStorage(config.EVIDENCE_STORAGE_DIR),
  secretBox: new SecretBox(config.SERVER_ENCRYPTION_KEY),
  now: () => new Date(),
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
