const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:/Users/RABBI MANDOL/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost/webhat-desk/api/webhook.php';
const DESK_URL = WEBHOOK_URL.replace(/\/api\/[^/]+$/, '');
const BRIDGE_SECRET_TOKEN = process.env.BRIDGE_SECRET_TOKEN || 'webhat_bridge_secure_2024';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const AUTH_DIR = process.env.AUTH_DIR ? path.join(process.env.AUTH_DIR, 'auth_info_baileys') : path.join(__dirname, 'auth_info_baileys');
const LID_MAP_FILE = process.env.AUTH_DIR ? path.join(process.env.AUTH_DIR, 'lid_map.json') : path.join(__dirname, 'lid_map.json');

let lidMap = {
    '69230577860638@lid': '8801764983880'
};
try {
    if (fs.existsSync(LID_MAP_FILE)) {
        lidMap = { ...lidMap, ...JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8')) };
    }
} catch (e) {}

const unreadKeysByJid = {};
const unreadKeysByPhone = {};

function saveLidMap() {
    try {
        fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidMap, null, 2));
    } catch (e) {}
}

// Upload incoming WhatsApp media to PHP server for permanent hosting
async function uploadMediaToDesk(buffer, mediaType, ext) {
    try {
        const uploadUrl = `${DESK_URL}/api/bridge_upload.php?type=${mediaType}&ext=${ext}&token=${BRIDGE_SECRET_TOKEN}`;
        const response = await axios.post(uploadUrl, buffer, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Bridge-Token': BRIDGE_SECRET_TOKEN
            },
            timeout: 20000,
            maxContentLength: 50 * 1024 * 1024
        });
        if (response.data && response.data.url) {
            console.log(`[Baileys] Media uploaded to desk: ${response.data.url}`);
            return response.data.url;
        }
    } catch (err) {
        console.error('[Baileys] Failed to upload media to desk:', err.message);
    }
    return null;
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let currentQR = null;
let isConnected = false;
let connectedPhone = null;

// In-memory message store to resolve retry requests and 'Waiting for message' E2EE
const messageStore = new Map();
function saveMessageToStore(id, message) {
    if (id && message) {
        messageStore.set(id, message);
        if (messageStore.size > 2000) {
            const first = messageStore.keys().next().value;
            messageStore.delete(first);
        }
    }
}

async function initWhatsApp() {
    if (sock) {
        try { sock.end(undefined); } catch(e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys Bridge] Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false, // Prevents 24/7 constant online bot flag & keeps phone notifications active!
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            if (key?.id && messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return undefined;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Track Phone Number Share events for LIDs
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) {
            const pn = jid.replace('@s.whatsapp.net', '').split(':')[0];
            lidMap[lid] = pn;
            saveLidMap();
            console.log(`[Baileys] Learned LID mapping: ${lid} -> ${pn}`);
        }
    });

    // Track Delivery Receipts / Status updates
    sock.ev.on('messages.update', (updates) => {
        for (const u of updates) {
            if (u.update?.status) {
                console.log(`[Baileys Status] Msg ID: ${u.key?.id}, status: ${u.update.status}`);
            }
        }
    });

    // Sync Existing Customer Chats & History
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`[Baileys Bridge] History Sync: ${chats?.length || 0} chats, ${messages?.length || 0} messages`);
        
        const nameMap = {};
        if (contacts) {
            for (const c of contacts) {
                if (c.id && (c.name || c.notify)) {
                    const p = c.id.split('@')[0].split(':')[0];
                    nameMap[p] = c.name || c.notify;
                }
            }
        }

        // Process chats list
        if (chats && chats.length > 0) {
            for (const c of chats) {
                if (!c.id || c.id.endsWith('@g.us') || c.id === 'status@broadcast') continue;
                const from = c.id.replace('@s.whatsapp.net', '').split(':')[0];
                const senderName = nameMap[from] || c.name || ('Customer ' + from.slice(-4));
                const timestamp = c.conversationTimestamp ? String(c.conversationTimestamp) : String(Math.floor(Date.now() / 1000));
                
                try {
                    await axios.post(WEBHOOK_URL + '?action=history_sync', {
                        phone: from,
                        name: senderName,
                        body: 'WhatsApp conversation',
                        from_me: false,
                        msg_id: 'chat_' + from,
                        timestamp: timestamp
                    }, { timeout: 4000 });
                } catch (e) {}
            }
        }

        if (messages && messages.length > 0) {
            for (const msg of messages) {
                if (!msg.key.remoteJid || msg.key.remoteJid.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') continue;
                
                const from = msg.key.remoteJid.replace('@s.whatsapp.net', '').split(':')[0];
                const senderName = nameMap[from] || msg.pushName || ('Customer ' + from.slice(-4));
                const fromMe = !!msg.key.fromMe;
                
                let textBody = '';
                const content = msg.message;
                if (!content) continue;

                if (content.conversation) textBody = content.conversation;
                else if (content.extendedTextMessage?.text) textBody = content.extendedTextMessage.text;
                else if (content.imageMessage) textBody = content.imageMessage.caption || '📷 Photo';
                else if (content.audioMessage) textBody = '🎤 Voice Message';
                else if (content.videoMessage) textBody = content.videoMessage.caption || '🎥 Video';
                else if (content.documentMessage) textBody = content.documentMessage.fileName || '📄 Document';
                else textBody = '[Message]';

                const timestamp = msg.messageTimestamp ? String(msg.messageTimestamp) : String(Math.floor(Date.now() / 1000));

                try {
                    await axios.post(WEBHOOK_URL + '?action=history_sync', {
                        phone: from,
                        name: senderName,
                        body: textBody,
                        from_me: fromMe,
                        msg_id: msg.key.id || ('hist_' + Date.now()),
                        timestamp: timestamp
                    }, { timeout: 4000 });
                } catch (e) {}
            }
            console.log('[Baileys Bridge] Finished importing recent chat history!');
        }
    });

    // Also listen to incoming chats.upsert
    sock.ev.on('chats.upsert', async (newChats) => {
        if (!newChats) return;
        for (const c of newChats) {
            if (!c.id || c.id.endsWith('@g.us') || c.id === 'status@broadcast') continue;
            const from = c.id.replace('@s.whatsapp.net', '').split(':')[0];
            const senderName = c.name || ('Customer ' + from.slice(-4));
            const timestamp = c.conversationTimestamp ? String(c.conversationTimestamp) : String(Math.floor(Date.now() / 1000));
            try {
                await axios.post(WEBHOOK_URL + '?action=history_sync', {
                    phone: from,
                    name: senderName,
                    body: 'Recent conversation',
                    from_me: false,
                    msg_id: 'chat_up_' + from,
                    timestamp: timestamp
                }, { timeout: 4000 });
            } catch (e) {}
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('[Baileys Bridge] Stable QR Code ready! Waiting for user to scan...');
        }

        if (connection === 'close') {
            isConnected = false;
            connectedPhone = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[Baileys Bridge] Connection closed. Status code: ${statusCode}`);

            const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401);
            if (isLoggedOut) {
                console.log('[Baileys Bridge] Session invalidated or logged out. Resetting auth...');
                currentQR = null;
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
                setTimeout(initWhatsApp, 2500);
            } else if (statusCode === 428 || statusCode === 515 || statusCode === 408) {
                console.log('[Baileys Bridge] Reconnecting due to code ' + statusCode);
                setTimeout(initWhatsApp, 4000);
            } else if (!currentQR) {
                setTimeout(initWhatsApp, 4000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
            console.log(`\n======================================================`);
            console.log(`✅ [Baileys Bridge] WhatsApp CONNECTED! Phone: ${connectedPhone}`);
            console.log(`======================================================\n`);
        }
    });

    // Handle Incoming and Phone-outgoing Messages
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;

        for (const msg of m.messages) {
            try {
                if (!msg.key || !msg.key.remoteJid || msg.key.remoteJid.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') {
                    continue;
                }

                console.log(`[Baileys Incoming] RemoteJid: ${msg.key.remoteJid}, fromMe: ${msg.key.fromMe}, pushName: ${msg.pushName || 'N/A'}`);

                let content = msg.message;
                if (!content) continue;

                // Unwrap ephemeral and viewOnce wrappers
                if (content.ephemeralMessage?.message) {
                    content = content.ephemeralMessage.message;
                }
                if (content.viewOnceMessage?.message) {
                    content = content.viewOnceMessage.message;
                }
                if (content.viewOnceMessageV2?.message) {
                    content = content.viewOnceMessageV2.message;
                }
                if (content.documentWithCaptionMessage?.message) {
                    content = content.documentWithCaptionMessage.message;
                }

                // Ignore internal WhatsApp protocol sync messages
                if (content.protocolMessage || content.senderKeyDistributionMessage || content.keyExchangeMessage || (content.messageContextInfo && Object.keys(content).length === 1)) {
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                let realPhone = null;
                if (msg.key.senderPn) {
                    realPhone = msg.key.senderPn.replace('@s.whatsapp.net', '').split(':')[0];
                } else if (msg.key.participantPn) {
                    realPhone = msg.key.participantPn.replace('@s.whatsapp.net', '').split(':')[0];
                } else if (msg.key.remoteJidAlt) {
                    realPhone = msg.key.remoteJidAlt.replace('@s.whatsapp.net', '').split(':')[0];
                } else if (lidMap[remoteJid]) {
                    realPhone = lidMap[remoteJid];
                }

                if (remoteJid.endsWith('@lid') && realPhone) {
                    lidMap[remoteJid] = realPhone;
                    saveLidMap();
                }

                const from = realPhone || remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
                const isFromMe = !!msg.key.fromMe;
                const senderName = isFromMe ? 'You' : (msg.pushName || ('Customer ' + from.slice(-4)));
                const msgId = msg.key.id;
                const timestamp = msg.messageTimestamp ? String(msg.messageTimestamp) : String(Math.floor(Date.now() / 1000));

                let textBody = '';
                let msgType = 'text';
                let mediaUrl = null;

                saveMessageToStore(msgId, content);

                // Message delivered to recipient device (WhatsApp naturally shows Double Gray Tick)
                // We queue msg.key so it only turns Blue Tick when the agent opens the chat in WebHat Desk or replies
                if (!isFromMe && msg.key) {
                    if (!unreadKeysByJid[remoteJid]) unreadKeysByJid[remoteJid] = [];
                    unreadKeysByJid[remoteJid].push(msg.key);
                    if (from) {
                        if (!unreadKeysByPhone[from]) unreadKeysByPhone[from] = [];
                        unreadKeysByPhone[from].push(msg.key);
                    }
                    if (unreadKeysByJid[remoteJid].length > 50) unreadKeysByJid[remoteJid].shift();
                    console.log(`[Baileys Delivered] Msg ${msgId} from ${from} delivered (Gray double-tick). Will turn Blue when opened in WebHat.`);
                }

                if (content.conversation) {
                    textBody = content.conversation;
                    msgType = 'text';
                } else if (content.extendedTextMessage?.text) {
                    textBody = content.extendedTextMessage.text;
                    msgType = 'text';
                } else if (content.audioMessage) {
                    msgType = 'audio';
                    textBody = '🎤 Voice Message';
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        mediaUrl = await uploadMediaToDesk(buffer, 'audio', 'ogg');
                    } catch (err) {
                        console.error('[Baileys] Error downloading audio:', err.message);
                    }
                } else if (content.imageMessage) {
                    msgType = 'image';
                    textBody = content.imageMessage.caption || '📷 Photo';
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        mediaUrl = await uploadMediaToDesk(buffer, 'image', 'jpg');
                    } catch (err) {
                        console.error('[Baileys] Error downloading image:', err.message);
                    }
                } else if (content.videoMessage) {
                    msgType = 'video';
                    textBody = content.videoMessage.caption || '🎥 Video';
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        mediaUrl = await uploadMediaToDesk(buffer, 'video', 'mp4');
                    } catch (err) {
                        console.error('[Baileys] Error downloading video:', err.message);
                    }
                } else if (content.documentMessage) {
                    msgType = 'document';
                    textBody = content.documentMessage.fileName || '📄 Document';
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const docExt = path.extname(content.documentMessage.fileName || '').replace('.', '') || 'pdf';
                        mediaUrl = await uploadMediaToDesk(buffer, 'document', docExt);
                    } catch (err) {
                        console.error('[Baileys] Error downloading document:', err.message);
                    }
                }

                // Skip empty text messages
                if (msgType === 'text' && (!textBody || !textBody.trim())) {
                    continue;
                }

                console.log(`[Baileys Processed] Type: ${msgType}, From: ${from} (${senderName}), Body: "${textBody.substring(0, 60)}"`);

                if (isFromMe) {
                    try {
                        await axios.post(WEBHOOK_URL + '?action=history_sync', {
                            phone: from,
                            name: 'Customer ' + from.slice(-4),
                            body: textBody,
                            media_url: mediaUrl,
                            media_type: mediaUrl ? msgType : null,
                            from_me: true,
                            msg_id: msgId,
                            timestamp: timestamp
                        }, { timeout: 5000 });
                    } catch (postErr) {
                        console.error('[Baileys] Error syncing phone outgoing message:', postErr.message);
                    }
                    continue;
                }

                // Forward to PHP Webhook in Meta-compatible format
                const webhookPayload = {
                    object: 'whatsapp_business_account',
                    entry: [{
                        id: 'baileys_gateway',
                        changes: [{
                            field: 'messages',
                            value: {
                                messaging_product: 'whatsapp',
                                metadata: {
                                    display_phone_number: connectedPhone || '',
                                    phone_number_id: 'baileys'
                                },
                                contacts: [{
                                    profile: { name: senderName },
                                    wa_id: from
                                }],
                                messages: [{
                                    from: from,
                                    id: msgId,
                                    timestamp: timestamp,
                                    type: msgType,
                                    text: { body: textBody },
                                    ...(mediaUrl ? { [msgType]: { url: mediaUrl, link: mediaUrl } } : {})
                                }]
                            }
                        }]
                    }]
                };

                try {
                    const res = await axios.post(WEBHOOK_URL, webhookPayload, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 10000
                    });
                    console.log(`[Baileys Webhook] Successfully forwarded message from ${from} to PHP webhook (Status ${res.status})`);
                } catch (postErr) {
                    console.error('[Baileys] Error forwarding to PHP webhook:', postErr.message);
                }
            } catch (itemErr) {
                console.error('[Baileys] Error processing message item in loop:', itemErr.message);
            }
        }
    });
}

// REST Endpoints
app.get('/relink', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch(e) {}
            try { sock.end(undefined); } catch(e) {}
        }
        isConnected = false;
        connectedPhone = null;
        currentQR = null;
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
        setTimeout(initWhatsApp, 1500);
        res.redirect('/qr');
    } catch (err) {
        res.status(500).send('Relink error: ' + err.message);
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: connectedPhone,
        hasQr: !!currentQR
    });
});

app.post('/mark-read', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !sock) {
        return res.json({ success: false, error: 'Socket not ready or phone missing' });
    }
    try {
        let clean = phone.replace(/[^0-9]/g, '');
        if (clean.startsWith('01') && clean.length === 11) clean = '88' + clean;

        const mappedLid = Object.keys(lidMap).find(k => lidMap[k] === clean);
        const jid = mappedLid || (phone.includes('@') ? phone : `${clean}@s.whatsapp.net`);

        // Collect all unread message keys for this sender
        const keys = [
            ...(unreadKeysByJid[jid] || []),
            ...(unreadKeysByPhone[clean] || []),
            ...(mappedLid && unreadKeysByJid[mappedLid] ? unreadKeysByJid[mappedLid] : [])
        ];

        if (keys.length > 0) {
            await sock.readMessages(keys);
            console.log(`[Baileys Read] Agent viewed chat! Sent BLUE DOUBLE-TICKS for ${keys.length} msgs from ${clean} (${jid})`);
        }

        // Clear local unread queue
        delete unreadKeysByJid[jid];
        delete unreadKeysByPhone[clean];
        if (mappedLid) delete unreadKeysByJid[mappedLid];

        try {
            await sock.chatModify({ markRead: true, lastMessages: [] }, jid);
        } catch(e) {}

        res.json({ success: true, marked: keys.length });
    } catch (err) {
        console.error('[Baileys Read] Error marking read:', err.message);
        res.json({ success: false, error: err.message });
    }
});

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WebHat - WhatsApp Connected</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: #131b2e; border: 1px solid #1e293b; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); max-width: 420px; }
                    .badge { display: inline-block; background: #10b981; color: #fff; padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 0.9rem; margin-bottom: 20px; }
                    h2 { margin: 0 0 10px; font-size: 1.5rem; }
                    p { color: #94a3b8; font-size: 0.95rem; margin-bottom: 25px; }
                    a { display: inline-block; background: #0d9488; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; }
                </style>
            </head>
            <body>
                <div class="card">
                    <span class="badge">✅ WhatsApp Connected</span>
                    <h2>Connected to: ${connectedPhone || 'Your Phone'}</h2>
                    <p>WebHat Support Desk is now actively linked to your WhatsApp Business phone! Voice calls will ring on your phone, and all chats will sync to WebHat Desk.</p>
                    <a href="http://localhost/webhat-desk/">Go to WebHat Desk Inbox</a>
                </div>
            </body>
            </html>
        `);
    }

app.get('/webhat-desk*', (req, res) => {
    res.redirect('http://localhost/webhat-desk/');
});

    if (!currentQR) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="refresh" content="2">
                <title>Generating QR...</title>
                <style>
                    body { font-family: sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                </style>
            </head>
            <body>
                <div style="text-align: center;">
                    <h2>🔄 Generating WhatsApp QR Code...</h2>
                    <p style="color: #94a3b8;">Please wait 2 seconds, page will refresh automatically.</p>
                </div>
            </body>
            </html>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR, { width: 320, margin: 2 });
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WebHat - Link WhatsApp Business</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="refresh" content="6">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
                    .card { background: #131b2e; border: 1px solid #1e293b; padding: 35px 30px; border-radius: 16px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 440px; width: 100%; }
                    h2 { margin: 0 0 8px; font-size: 1.4rem; color: #f8fafc; }
                    .desc { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; margin-bottom: 20px; }
                    .qr-wrap { background: #ffffff; padding: 14px; border-radius: 12px; display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
                    .qr-wrap img { display: block; border-radius: 6px; }
                    .steps { text-align: left; background: #090d16; border: 1px solid rgba(255,255,255,0.06); padding: 16px 20px; border-radius: 10px; margin-top: 25px; font-size: 0.85rem; color: #cbd5e1; }
                    .steps ol { margin: 0; padding-left: 18px; }
                    .steps li { margin-bottom: 6px; }
                    .steps li:last-child { margin-bottom: 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>📲 Link Your WhatsApp Business</h2>
                    <p class="desc">Scan this QR code from your phone's WhatsApp Business app to link it directly with WebHat Support Desk.</p>
                    <div class="qr-wrap">
                        <img src="${qrImage}" alt="Scan QR Code">
                    </div>
                    <div class="steps">
                        <ol>
                            <li>Open <strong>WhatsApp Business</strong> on your phone</li>
                            <li>Tap <strong>Settings</strong> ➔ <strong>Linked Devices</strong></li>
                            <li>Tap <strong>Link a device</strong></li>
                            <li>Point your phone camera at this QR code!</li>
                        </ol>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (qrErr) {
        res.status(500).send('Error generating QR code: ' + qrErr.message);
    }
});

function extractAudioWaveform(filePath) {
    try {
        const ffmpegBin = fs.existsSync(FFMPEG_PATH) ? `"${FFMPEG_PATH}"` : 'ffmpeg';
        const rawPcm = execSync(`${ffmpegBin} -i "${filePath}" -f s16le -ac 1 -ar 8000 -v error pipe:1`, { maxBuffer: 10 * 1024 * 1024 });
        const int16 = new Int16Array(rawPcm.buffer, rawPcm.byteOffset, Math.floor(rawPcm.length / 2));
        const samples = 64;
        const blockSize = Math.max(1, Math.floor(int16.length / samples));
        const amplitudes = [];

        for (let i = 0; i < samples; i++) {
            let sum = 0;
            const start = i * blockSize;
            const end = Math.min(start + blockSize, int16.length);
            for (let j = start; j < end; j++) {
                sum += Math.abs(int16[j]);
            }
            amplitudes.push(sum / (end - start || 1));
        }

        const max = Math.max(...amplitudes, 1);
        const waveform = new Uint8Array(samples);
        for (let i = 0; i < samples; i++) {
            waveform[i] = Math.max(4, Math.min(100, Math.floor((amplitudes[i] / max) * 95) + 4));
        }
        return waveform;
    } catch (e) {
        const fallback = new Uint8Array(64);
        for (let i = 0; i < 64; i++) {
            fallback[i] = Math.floor(15 + 65 * Math.sin((i / 64) * Math.PI) * (0.6 + 0.4 * Math.random()));
        }
        return fallback;
    }
}

// Outbound Message Dispatch
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(503).json({ error: 'WhatsApp is not connected. Please scan QR code first.' });
    }

    let { phone, message, mediaUrl, mediaType } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Resolve target JID correctly
    let target = phone.trim();
    let jid;

    if (target.endsWith('@lid')) {
        // Send directly to the active LID session!
        jid = target;
    } else if (target.endsWith('@s.whatsapp.net') || target.endsWith('@g.us')) {
        jid = target;
    } else {
        let clean = target.replace(/[^0-9]/g, '');
        if (clean.startsWith('01') && clean.length === 11) {
            clean = '88' + clean;
        }
        // If there is an active LID session for this contact, route to it!
        const mappedLid = Object.keys(lidMap).find(k => lidMap[k] === clean);
        if (mappedLid) {
            jid = mappedLid;
            console.log(`[Baileys /send] Routing to active LID session ${mappedLid} for phone ${clean}`);
        } else {
            jid = `${clean}@s.whatsapp.net`;
        }
    }

    console.log(`[Baileys /send] Dispatching to JID: ${jid}, message: "${(message || '').substring(0, 40)}"`);

    try {
        // Natural human typing simulation:
        // Dynamic typing delay (1.1s to 3.2s based on message length + randomized human jitter)
        const textLen = (message || '').length;
        let typingDelayMs = 1100;
        if (textLen > 100) {
            typingDelayMs = 2400 + Math.floor(Math.random() * 800);
        } else {
            typingDelayMs = 1000 + Math.floor(Math.random() * 500);
        }

        // Sync presence to update Linked Device active timestamp on phone
        try { await sock.sendPresenceUpdate('available'); } catch(e) {}
        try {
            const pendingKeys = [...(unreadKeysByJid[jid] || []), ...(unreadKeysByPhone[clean] || [])];
            if (pendingKeys.length > 0) {
                await sock.readMessages(pendingKeys);
                delete unreadKeysByJid[jid];
                delete unreadKeysByPhone[clean];
            }
            await sock.chatModify({ markRead: true, lastMessages: [] }, jid);
        } catch(e) {}

        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, typingDelayMs));

        let sentMsg = null;

        if (mediaUrl) {
            let fileBuffer = null;
            let localFilePath = null;

            if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
                // Download from full URL (PHP server on StackCP)
                try {
                    console.log(`[Baileys /send] Downloading media from URL: ${mediaUrl}`);
                    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 20000 });
                    fileBuffer = Buffer.from(response.data);
                    console.log(`[Baileys /send] Downloaded ${fileBuffer.length} bytes`);
                } catch (dlErr) {
                    console.error('[Baileys /send] Failed to download media:', dlErr.message);
                }
            } else {
                // Legacy: local file path
                const relativePath = mediaUrl.replace(/^\/?uploads\//, '');
                localFilePath = path.join(UPLOADS_DIR, relativePath);
                if (fs.existsSync(localFilePath)) {
                    fileBuffer = fs.readFileSync(localFilePath);
                }
            }

            if (fileBuffer) {
                // Save temp file for audio processing
                const tmpPath = path.join(UPLOADS_DIR, `tmp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);
                if (mediaType === 'audio') {
                    let audioToSend = fileBuffer;
                    let targetAudioPath = tmpPath + '.audio';
                    fs.writeFileSync(targetAudioPath, fileBuffer);

                    const tempOgg = path.join(UPLOADS_DIR, `ptt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.ogg`);
                    try {
                        const ffmpegBin = fs.existsSync(FFMPEG_PATH) ? `"${FFMPEG_PATH}"` : 'ffmpeg';
                        execSync(`${ffmpegBin} -i "${targetAudioPath}" -c:a libopus -b:a 32k -ar 48000 -ac 1 -vbr on -avoid_negative_ts make_zero -map_metadata -1 -application voip -y "${tempOgg}"`, { stdio: 'pipe' });
                        if (fs.existsSync(tempOgg) && fs.statSync(tempOgg).size > 0) {
                            audioToSend = fs.readFileSync(tempOgg);
                            const waveform = extractAudioWaveform(tempOgg);
                            try { fs.unlinkSync(targetAudioPath); } catch(e) {}
                            try { fs.unlinkSync(tempOgg); } catch(e) {}
                            sentMsg = await sock.sendMessage(jid, {
                                audio: audioToSend,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                waveform: waveform
                            });
                        } else {
                            throw new Error('ffmpeg output empty');
                        }
                    } catch (convErr) {
                        console.error('Audio conversion error:', convErr.message);
                        try { fs.unlinkSync(targetAudioPath); } catch(e) {}
                        // Fallback: send raw audio
                        const waveform = extractAudioWaveform(tmpPath + '.audio');
                        sentMsg = await sock.sendMessage(jid, {
                            audio: fileBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                            waveform: waveform
                        });
                    }
                } else if (mediaType === 'image') {
                    sentMsg = await sock.sendMessage(jid, {
                        image: fileBuffer,
                        caption: message || ''
                    });
                } else if (mediaType === 'video') {
                    sentMsg = await sock.sendMessage(jid, {
                        video: fileBuffer,
                        caption: message || ''
                    });
                } else {
                    sentMsg = await sock.sendMessage(jid, {
                        document: fileBuffer,
                        mimetype: 'application/octet-stream',
                        fileName: path.basename(mediaUrl)
                    });
                }
            } else {
                // Fallback to text if file missing/download failed
                console.warn('[Baileys /send] Media unavailable, sending as text');
                sentMsg = await sock.sendMessage(jid, { text: message || mediaUrl });
            }
        } else if (message) {
            sentMsg = await sock.sendMessage(jid, { text: message });
        }

        // Cache message for retry decryption requests
        if (sentMsg?.key?.id && sentMsg?.message) {
            saveMessageToStore(sentMsg.key.id, sentMsg.message);
        }

        await sock.sendPresenceUpdate('paused', jid);
        setTimeout(async () => {
            try { await sock.sendPresenceUpdate('unavailable'); } catch(e) {}
        }, 12000);

        res.json({
            success: true,
            messageId: sentMsg?.key?.id || ('baileys_' + Date.now())
        });
    } catch (sendErr) {
        console.error('[Baileys] Error sending message:', sendErr.message);
        res.status(500).json({ error: sendErr.message });
    }
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 WebHat WhatsApp Baileys Bridge running on port ${PORT}`);
    console.log(`👉 Open http://localhost:${PORT}/qr to scan QR Code!`);
    console.log(`====================================================`);
    initWhatsApp();
});
