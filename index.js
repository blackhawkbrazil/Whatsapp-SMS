require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { execFile } = require('child_process');

// ----------------- Configuração -----------------
const SMS_TO = onlyDigits(process.env.SMS_TO || '');            // seu celular (destino dos WA)
const ALLOWED = (process.env.ALLOWED_SENDERS || '')             // quem pode comandar via SMS
  .split(',')
  .map((s) => onlyDigits(s))
  .filter(Boolean);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const MAX_SMS_LEN = parseInt(process.env.MAX_SMS_LEN || '300', 10);
const FORWARD_GROUPS = process.env.FORWARD_GROUPS === 'true';

if (!SMS_TO) {
  console.error('ERRO: defina SMS_TO no .env (seu número de celular).');
  process.exit(1);
}

const logger = pino({ level: 'silent' });
let sock = null;        // socket do WhatsApp
let ready = false;      // conectado?
let lastContact = null; // JID de quem te mandou a última mensagem (para resposta sem prefixo)
const nameCache = {};   // jid -> melhor nome de perfil já visto
const aliasToJid = {};  // "1" -> jid    (apelido curto para responder por SMS)
const jidToAlias = {};  // jid -> "1"
let aliasCounter = 0;

// ----------------- Utilidades -----------------
function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Conjunto básico GSM-7. Se o texto tiver algo fora disso, mandamos como Unicode.
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà€^{}\\[~]|';

function needsUnicode(text) {
  return [...text].some((c) => !GSM7.includes(c));
}

function truncate(text) {
  if (text.length <= MAX_SMS_LEN) return text;
  return text.slice(0, MAX_SMS_LEN - 1) + '…';
}

// Envia SMS pelo gammu-smsd (coloca na fila de saída; o daemon transmite)
function sendSMS(number, text) {
  return new Promise((resolve, reject) => {
    const body = truncate(text);
    const args = ['TEXT', number, '-text', body];
    if (needsUnicode(body)) args.push('-unicode');
    execFile('gammu-smsd-inject', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Apelido curto e estável por contato (ex.: "1", "2"...) para responder via SMS
function aliasFor(jid) {
  if (jidToAlias[jid]) return jidToAlias[jid];
  aliasCounter += 1;
  const a = String(aliasCounter);
  jidToAlias[jid] = a;
  aliasToJid[a] = jid;
  return a;
}

// Tenta descobrir o telefone real (o WhatsApp hoje usa LID, que NÃO é o número).
// Retorna só dígitos, ou null se não der.
function resolvePhone(jid, msg) {
  const num = (j) => (j || '').split('@')[0].split(':')[0];
  if (jid.endsWith('@s.whatsapp.net')) return num(jid);
  // Campos "alt" trazem o número quando o jid principal é LID (Baileys recente)
  const alt = msg?.key?.remoteJidAlt || msg?.key?.participantAlt;
  if (alt && alt.endsWith('@s.whatsapp.net')) return num(alt);
  try {
    const pn = sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
    if (pn) return num(pn);
  } catch (_) { /* ignora */ }
  return null;
}

// Descreve a mensagem do Baileys: devolve o texto, ou um rótulo para mídia
// (áudio, imagem, etc.), ou null para mensagens de sistema que não interessam.
function describeMessage(message) {
  if (!message) return null;

  // desembrulha mensagens "efêmeras" / "ver uma vez" / documento com legenda
  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.viewOnceMessageV2Extension?.message ||
    message.documentWithCaptionMessage?.message ||
    message;

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  if (m.audioMessage) return m.audioMessage.ptt ? '[áudio de voz]' : '[áudio]';
  if (m.imageMessage)
    return m.imageMessage.caption ? `[imagem] ${m.imageMessage.caption}` : '[imagem]';
  if (m.videoMessage) {
    if (m.videoMessage.gifPlayback) return '[gif]';
    return m.videoMessage.caption ? `[vídeo] ${m.videoMessage.caption}` : '[vídeo]';
  }
  if (m.stickerMessage) return '[figurinha]';
  if (m.documentMessage) return `[documento: ${m.documentMessage.fileName || 'arquivo'}]`;
  if (m.locationMessage || m.liveLocationMessage) return '[localização]';
  if (m.contactMessage) return `[contato] ${m.contactMessage.displayName || ''}`.trim();
  if (m.contactsArrayMessage) return '[contatos]';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '[enquete]';

  // mensagens de sistema que não devem virar SMS
  if (
    m.reactionMessage ||
    m.protocolMessage ||
    m.senderKeyDistributionMessage ||
    m.messageContextInfo
  )
    return null;

  return '[mensagem]';
}

function isAllowed(fromNumber) {
  if (ALLOWED.length === 0) return true; // sem allowlist => libera (não recomendado)
  const f = onlyDigits(fromNumber);
  // compara pelo final, porque o SMS pode chegar com/sem código de país
  return ALLOWED.some((a) => f.endsWith(a) || a.endsWith(f));
}

// ----------------- WhatsApp (Baileys) -----------------
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`WhatsApp Web v${version.join('.')} (atual: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\nEscaneie o QR Code abaixo no WhatsApp (Aparelhos conectados):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      ready = true;
      console.log('WhatsApp conectado.');
    }
    if (connection === 'close') {
      ready = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(
        `WhatsApp desconectado. (codigo=${code})`,
        loggedOut ? '(logout)' : '(reconecta em 5s)'
      );
      if (!loggedOut) {
        setTimeout(startWhatsApp, 5000);
      } else {
        console.log('Sessao deslogada. Apague a pasta auth/ e pareie de novo.');
      }
    }
  });

  // Mensagens recebidas no WhatsApp -> repassa por SMS
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;

        const isGroup = jid.endsWith('@g.us');
        if (isGroup && !FORWARD_GROUPS) continue;

        const text = describeMessage(msg.message);
        if (!text) continue; // mensagens de sistema (reações, recibos, etc.)

        lastContact = jid;
        const alias = aliasFor(jid);
        if (msg.pushName) nameCache[jid] = msg.pushName;
        const name = nameCache[jid] || 'sem nome';
        const phone = resolvePhone(jid, msg);
        const who = phone ? `${name} (${phone})` : name;
        const prefix = isGroup ? `WA grupo ${who}` : `WA ${who}`;
        const sms = `#${alias} ${prefix}: ${text}`;

        await sendSMS(SMS_TO, sms);
        console.log('-> SMS enviado:', sms.slice(0, 60));
      } catch (e) {
        console.error('Falha ao repassar WA->SMS:', e.message);
      }
    }
  });
}

// ----------------- Servidor HTTP (recebe SMS do gammu) -----------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/sms-in', async (req, res) => {
  const from = req.body.from || '';
  const text = (req.body.text || '').trim();

  if (!isAllowed(from)) {
    console.warn('SMS bloqueado de remetente não autorizado:', from);
    return res.status(403).send('forbidden');
  }
  if (!ready || !sock) {
    return res.status(503).send('whatsapp nao conectado');
  }
  if (!text) {
    return res.status(400).send('mensagem vazia');
  }

  let targetJid;
  let message;

  if (text.startsWith('#')) {
    // Responder usando o apelido curto mostrado no SMS (ex.: "#3 ola")
    const sp = text.indexOf(' ');
    if (sp === -1) return res.status(400).send('formato: #apelido mensagem');
    const alias = onlyDigits(text.slice(1, sp));
    message = text.slice(sp + 1).trim();
    targetJid = aliasToJid[alias];
    if (!targetJid) return res.status(400).send(`apelido #${alias} desconhecido`);
    if (!message) return res.status(400).send('mensagem vazia');
  } else if (text.startsWith('@')) {
    // Iniciar conversa com um número novo (codigo do pais + DDD + numero)
    const sp = text.indexOf(' ');
    if (sp === -1) return res.status(400).send('formato: @numero mensagem');
    const num = onlyDigits(text.slice(1, sp));
    message = text.slice(sp + 1).trim();
    if (!num || !message) return res.status(400).send('formato: @numero mensagem');
    try {
      const found = await sock.onWhatsApp(num);
      targetJid = found && found[0]?.exists ? found[0].jid : `${num}@s.whatsapp.net`;
    } catch (_) {
      targetJid = `${num}@s.whatsapp.net`;
    }
  } else {
    // sem prefixo: responde para o último contato que te mandou mensagem
    if (!lastContact) return res.status(400).send('sem contato recente; use #apelido ou @numero');
    targetJid = lastContact;
    message = text;
  }

  try {
    await sock.sendMessage(targetJid, { text: message });
    console.log('<- WA enviado para', targetJid, ':', message.slice(0, 60));
    res.send('ok');
  } catch (e) {
    console.error('Falha ao enviar WA:', e.message);
    res.status(500).send('falha ao enviar');
  }
});

app.get('/health', (_req, res) => res.json({ ready }));

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`HTTP local ouvindo em 127.0.0.1:${HTTP_PORT}`);
});

startWhatsApp();
