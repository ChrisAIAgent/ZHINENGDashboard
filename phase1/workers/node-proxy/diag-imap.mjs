// IMAP diagnostic - verbose logging, identifies which command returns NO
import { ImapFlow } from 'imapflow';

const user = process.argv[2];
const pass = process.argv[3];
if (!user || !pass) { console.error('usage: node diag-imap.mjs <user> <pass>'); process.exit(2); }

const logger = {
  debug: (...args) => console.log('[DBG]', ...args.map(a => typeof a === 'object' ? JSON.stringify(a) : a)),
  info:  (...args) => console.log('[INF]', ...args.map(a => typeof a === 'object' ? JSON.stringify(a) : a)),
  warn:  (...args) => console.log('[WRN]', ...args.map(a => typeof a === 'object' ? JSON.stringify(a) : a)),
  error: (...args) => console.log('[ERR]', ...args.map(a => typeof a === 'object' ? JSON.stringify(a) : a)),
};

const client = new ImapFlow({
  host: 'outlook.office365.com',
  port: 993,
  secure: true,
  auth: { user, pass },
  logger,
  emitLogs: true,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  clientInfo: { name: 'diag', version: '1.0' },
});

try {
  console.log('--- 1. connect() ---');
  await client.connect();
  console.log('--- 2. auth state ---');
  console.log('   authenticated:', client.authenticated);
  console.log('--- 3. getMailboxLock(INBOX) ---');
  const lock = await client.getMailboxLock('INBOX');
  console.log('   mailbox locked');
  try {
    console.log('--- 4. search({since: 60d}) ---');
    const since = new Date(Date.now() - 60*86400000);
    const uids = await client.search({ since });
    console.log('   matched uids:', uids?.length ?? 0);
    if (uids && uids.length > 0) {
      console.log('   first 3 uids:', uids.slice(0, 3));
      console.log('--- 5. fetchOne on first uid ---');
      const m = await client.fetchOne(uids[0], { envelope: true, source: true, internalDate: true }, { uid: true });
      console.log('   envelope.subject:', m?.envelope?.subject);
    }
  } finally {
    lock.release();
  }
  console.log('--- DONE ---');
} catch (e) {
  console.log('--- EXCEPTION ---');
  console.log('   message:', e.message);
  console.log('   code:', e.code);
  console.log('   responseStatus:', e.responseStatus);
  console.log('   response (text):', e.responseText || e.response);
  console.log('   stack first 8:');
  console.log(e.stack.split('\n').slice(0, 8).join('\n'));
} finally {
  try { await client.logout(); } catch (_) {}
}