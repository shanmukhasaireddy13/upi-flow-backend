const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { parseFamPayEmail } = require('./emailParser');
const { processIncomingPayment } = require('./matcher');
const { supabase } = require('../config/supabase');

class ImapIdleService {
  constructor(config = {}) {
    this.user = config.user || process.env.IMAP_USER;
    this.password = config.password || process.env.IMAP_PASSWORD;
    this.host = config.host || process.env.IMAP_HOST || 'imap.gmail.com';
    this.port = parseInt(config.port || process.env.IMAP_PORT || '993', 10);
    this.tls = config.tls !== undefined ? config.tls : true;
    this.imap = null;
    this.isConnected = false;
  }

  start() {
    if (!this.user || !this.password) {
      console.log('[IMAP IDLE] No IMAP credentials found. Ingestion running in Webhook mode.');
      return;
    }

    console.log(`[IMAP IDLE] Connecting to ${this.host}:${this.port} as ${this.user}...`);

    this.imap = new Imap({
      user: this.user,
      password: this.password,
      host: this.host,
      port: this.port,
      tls: this.tls,
      tlsOptions: { rejectUnauthorized: true },
      keepalive: true
    });

    this.imap.once('ready', () => {
      this.isConnected = true;
      console.log('[IMAP IDLE] ✅ Connected to Gmail over TLS. Entering passive IDLE state...');
      this.openInbox();
    });

    this.imap.once('error', (err) => {
      console.error('[IMAP IDLE] Connection error:', err.message);
      this.reconnect();
    });

    this.imap.once('end', () => {
      console.log('[IMAP IDLE] Connection closed.');
      this.isConnected = false;
      this.reconnect();
    });

    this.imap.connect();
  }

  openInbox() {
    this.imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        console.error('[IMAP IDLE] Failed to open INBOX:', err.message);
        return;
      }

      console.log('[IMAP IDLE] 👂 Listening for real-time FamApp push alerts...');

      // Gmail pushes 'mail' event over open socket the instant an email arrives
      this.imap.on('mail', (numNewMsgs) => {
        console.log(`[IMAP IDLE] Push event received: ${numNewMsgs} new email(s).`);
        this.fetchLatestEmail();
      });
    });
  }

  fetchLatestEmail() {
    this.imap.search(['UNSEEN', ['FROM', 'famapp.in']], (err, results) => {
      if (err || !results || results.length === 0) {
        // Fallback: search for any UNSEEN message with "successfully received"
        this.imap.search(['UNSEEN'], (fallbackErr, fallbackResults) => {
          if (fallbackErr || !fallbackResults || fallbackResults.length === 0) return;
          this.fetchAndProcess(fallbackResults[fallbackResults.length - 1]);
        });
        return;
      }
      this.fetchAndProcess(results[results.length - 1]);
    });
  }

  fetchAndProcess(msgId) {
    const f = this.imap.fetch(msgId, { bodies: '' });

    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) {
            console.error('[IMAP IDLE] Error parsing email stream:', err.message);
            return;
          }

          const rawBody = parsed.text || parsed.html || '';
          const parsedPayment = parseFamPayEmail(rawBody);
          if (!parsedPayment) return;

          // The mailbox owner is the merchant whose Google account is connected to this IMAP login.
          const { data: merchant } = await supabase
            .from('merchants')
            .select('id')
            .eq('google_email', this.user)
            .maybeSingle();

          console.log(`[IMAP IDLE] Parsed FamApp receipt: ₹${parsedPayment.amount} (${parsedPayment.transactionId})`);
          await processIncomingPayment(parsedPayment, rawBody, merchant ? merchant.id : null);
        });
      });
    });
  }

  reconnect() {
    if (!this.isConnected && this.user && this.password) {
      console.log('[IMAP IDLE] Attempting reconnect in 15 seconds...');
      setTimeout(() => this.start(), 15000);
    }
  }
}

module.exports = { ImapIdleService };
