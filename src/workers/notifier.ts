import { createMailer } from '../notifications/mailer.js';
import { dispatchDue } from '../notifications/dispatcher.js';
import { createRuntime, runLoop } from './runtime.js';

const { config, db, log } = createRuntime('notifier');
const mailer = createMailer(config);

await runLoop({
  name: 'notifier',
  intervalMs: config.NOTIFIER_POLL_INTERVAL_MS,
  log,
  tick: async () => {
    let sent: number;
    do {
      sent = await dispatchDue({ db, mailer, config, now: () => new Date(), log });
      if (sent > 0) log.info({ sent }, 'dispatched notifications');
    } while (sent === 100);
  },
  onStop: () => db.destroy(),
});
