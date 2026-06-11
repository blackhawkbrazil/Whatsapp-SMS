# wa-sms-bridge

> **Your WhatsApp, on any dumbphone.** Read and reply to WhatsApp over plain SMS — no smartphone, no data plan, no app. Just a SIM, a USB modem, and a Linux box.

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Baileys](https://img.shields.io/badge/WhatsApp-Baileys-25D366?logo=whatsapp&logoColor=white)
![gammu](https://img.shields.io/badge/SMS-gammu--smsd-blue)
![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green)

`wa-sms-bridge` turns a cheap 3G/4G USB modem and a Linux machine into a two-way relay between **WhatsApp** and **SMS**. Incoming WhatsApp messages land on your phone as text messages. Reply to that SMS thread and your words go back out over WhatsApp. Perfect for a backup phone, a remote cabin with no Wi-Fi, a feature phone, or just staying reachable when your battery-hungry smartphone is dead.

---

## Why this exists

WhatsApp assumes a smartphone with a data connection. SMS assumes nothing — it works on a 15-year-old Nokia with one bar of signal. This bridge gives you the **reach of WhatsApp** with the **resilience of SMS**:

- Travelling without roaming data? Get your WhatsApp on SMS.
- Phone in a drawer all day? A second number keeps you in the loop.
- Building home automation and want WhatsApp as an alert channel that survives a router reboot? Done.

---

## How it works

Two daemons, one tiny HTTP hop between them.

```mermaid
flowchart LR
    WA([Contact on WhatsApp])
    BAI[Baileys client<br/>Node.js]
    GAMMU[gammu-smsd<br/>+ 3G modem]
    PHONE([Your phone / SMS])

    WA -- "message in" --> BAI
    BAI -- "gammu-smsd-inject" --> GAMMU
    GAMMU -- "SMS out" --> PHONE
    PHONE -- "SMS reply" --> GAMMU
    GAMMU -- "RunOnReceive hook<br/>HTTP POST 127.0.0.1" --> BAI
    BAI -- "sendMessage" --> WA
```

- **WhatsApp side** — [Baileys](https://github.com/WhiskeySockets/Baileys) speaks the WhatsApp Multi-Device protocol over WebSocket. No headless Chrome, no Puppeteer; it stays light enough to run next to the modem on a Raspberry Pi.
- **SMS side** — [gammu-smsd](https://wammu.eu/smsd/) owns the modem's serial port, receives SMS (firing a hook script) and transmits from its outbox via `gammu-smsd-inject`. No port-locking conflicts.
- **The bridge** — the Node process exposes a localhost-only HTTP endpoint. The gammu hook `POST`s inbound SMS to it; the Node process shells out to `gammu-smsd-inject` for outbound. Loosely coupled, easy to reason about.

---

## Features

- **Two-way relay** — WhatsApp → SMS and SMS → WhatsApp.
- **Short reply aliases** — each contact gets a stable `#1`, `#2`, … tag, so you reply with `#3 hey there` instead of typing a phone number (and it sidesteps WhatsApp's new LID identifiers, which are *not* phone numbers).
- **Media awareness** — non-text messages don't vanish silently. Audio becomes `[voice note]`, plus `[image]`, `[video]`, `[sticker]`, `[document: file.pdf]`, `[location]`, `[contact]`, `[poll]`, and captioned media keep their caption.
- **Sender allowlist** — only numbers you trust can drive your WhatsApp from SMS. Without it, anyone who texts the SIM could send messages as you.
- **Smart SMS encoding** — auto-switches to Unicode when a message needs it (accents, emoji) and truncates to a configurable length to cap cost.
- **Group filter** — opt in to forward group chats; off by default to keep SMS volume sane.
- **systemd-ready** — survives reboots and auto-reconnects to WhatsApp.

---

## Requirements

- A Linux box (tested on Ubuntu 22.04 / 24.04). A Raspberry Pi works.
- Node.js 20+ (LTS recommended).
- A 3G/4G USB modem that exposes an AT serial port (e.g. Huawei E3531 / E173) with an active SIM that can send and receive SMS.
- `gammu`, `gammu-smsd`, `usb-modeswitch`.

---

## Quick start

```bash
# 1. System deps
sudo apt update
sudo apt install -y gammu gammu-smsd usb-modeswitch curl

# 2. Node 20 LTS (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Detect the modem port (note the device, usually /dev/ttyUSB0)
sudo gammu-detect

# 4. App
git clone https://github.com/<you>/wa-sms-bridge.git /opt/wa-sms-bridge
cd /opt/wa-sms-bridge
npm install
cp .env.example .env
$EDITOR .env            # set SMS_TO and ALLOWED_SENDERS to your number

# 5. gammu-smsd
sudo cp gammu-smsdrc.example /etc/gammu-smsdrc
$EDITOR /etc/gammu-smsdrc   # set the device from step 3
chmod +x on_receive.sh
sudo mkdir -p /var/spool/gammu/{inbox,outbox,sent,error}
sudo systemctl enable --now gammu-smsd

# 6. Pair WhatsApp (scan the QR printed in the terminal)
node index.js
```

Open WhatsApp → **Linked devices** → **Link a device**, and scan the QR rendered right there in your terminal. The session is saved to `auth/`, so you only pair once.

---

## Configuration

All settings live in `.env`:

| Variable          | Description                                                        | Example         |
| ----------------- | ----------------------------------------------------------------- | --------------- |
| `SMS_TO`          | Your phone number — where WhatsApp messages are forwarded.         | `5511987654321` |
| `ALLOWED_SENDERS` | Comma-separated numbers allowed to command via SMS. **Set this.**  | `5511987654321` |
| `HTTP_PORT`       | Localhost port for the internal SMS→app bridge.                    | `3000`          |
| `MAX_SMS_LEN`     | Max forwarded length before truncation (controls SMS cost).        | `300`           |
| `FORWARD_GROUPS`  | Forward group chats too? (`true` / `false`)                        | `false`         |

---

## Usage

Incoming WhatsApp messages arrive on your phone like this:

```
#3 WA John (5511999998888): hey, are you around?
```

The `#3` is that contact's reply tag. To respond, just reply to the SMS thread (it comes from the modem's SIM) using one of:

| You send (SMS)            | Effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `#3 on my way!`           | Reply to the contact tagged `#3`.                                                   |
| `@5511999998888 hi there` | Start/continue a chat with a specific number (country code + number, digits only).  |
| `on my way!`              | Reply to the **most recent** sender (no prefix needed).                            |

> Reply tags are rebuilt in memory on restart, so after a restart they re-appear as new messages come in. When in doubt, use the tag shown in the latest message you received.

---

## Run it for real (systemd)

```bash
sudo cp wa-sms-bridge.service /etc/systemd/system/
$EDITOR /etc/systemd/system/wa-sms-bridge.service   # set User / WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now wa-sms-bridge

# logs
journalctl -u wa-sms-bridge -f       # the WhatsApp side
tail -f /var/log/gammu-smsd.log       # the SMS side
```

---

## Troubleshooting

| Symptom                            | Likely cause / fix                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Cannot find module 'dotenv'`      | Run `npm install` inside the project dir.                                                                         |
| Reconnect loop, no QR shown        | Wrong server clock (`sudo timedatectl set-ntp true`) or outdated Baileys (`npm i @whiskeysockets/baileys@latest`). |
| `codigo=405` on disconnect         | WhatsApp rejected the client version — update Baileys.                                                            |
| Modem not found                    | Try `/dev/ttyUSB1` or `ttyUSB2`; check `dmesg \| grep ttyUSB`.                                                    |
| SMS sends but WhatsApp doesn't     | Check the allowlist and that the WhatsApp socket is connected.                                                    |
| The bracketed ID is a huge number  | That's WhatsApp's LID, not a phone number — use the `#tag` to reply.                                              |

---

## Roadmap

- [ ] Persistent reply tags (survive restarts)
- [ ] Optional contact-name sync
- [ ] Outbound media via short-lived web links
- [ ] Multi-instance helper for self-hosting a second number

---

## Disclaimer

This project uses an **unofficial** WhatsApp client (Baileys). Automating WhatsApp via unofficial clients violates WhatsApp's Terms of Service and may get your number banned. It is intended as a **personal, self-hosted** tool — use it with your own number, at your own risk. Not affiliated with or endorsed by WhatsApp / Meta. SMS messages are billed by your carrier; high-volume or group forwarding can get expensive fast.

---

## License

MIT — see [`LICENSE`](LICENSE).
