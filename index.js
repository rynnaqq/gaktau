import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import readline from 'readline';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';

const execFilePromise = util.promisify(execFile);

// Identifikasi Eksklusif Owner Tunggal (Nomor Telepon & WhatsApp LID)
const OWNER_MAIN_NUMBER = '6285143666343';
const OWNER_NUMBERS = [
    '6285143666343',      // Nomor Telepon WhatsApp Owner
    '14470281740424',     // WhatsApp LID Account Owner (Grup & Linked Device)
    '118679207415840'     // Secondary LID
];

const FORWARD_ANTI_DELETE_JID = `${OWNER_MAIN_NUMBER}@s.whatsapp.net`;

// Inisialisasi interface readline untuk CLI interaktif
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

let usePairingCode = false;
let phoneNumber = '';

// 1. Cache untuk deduplikasi ID pesan agar tidak diproses ganda
const processedMessageIds = new Set();

function markMessageProcessed(id) {
    if (!id) return false;
    if (processedMessageIds.has(id)) return true;
    processedMessageIds.add(id);

    if (processedMessageIds.size > 1000) {
        const oldestKey = processedMessageIds.values().next().value;
        processedMessageIds.delete(oldestKey);
    }
    return false;
}

// 2. In-Memory Store untuk Signal Retry & Fitur Anti-Delete
const messageStore = new Map();
const msgRetryCounterCache = new Map();

/**
 * Ekstrak nomor/LID murni dari JID WhatsApp
 */
function extractNumberFromJid(jid) {
    if (!jid) return '';
    const withoutDomain = jid.split('@')[0];
    const withoutDevice = withoutDomain.split(':')[0];
    return withoutDevice.replace(/[^0-9]/g, '');
}

/**
 * Mendapatkan nomor/LID pengirim dari pesan
 */
function getSenderNumber(msg, sock) {
    if (msg.key?.fromMe) {
        const botJid = sock?.user?.id || '';
        return extractNumberFromJid(botJid);
    }
    const rawJid = msg.key?.participant || msg.key?.remoteJid || '';
    return extractNumberFromJid(rawJid);
}

/**
 * Memeriksa secara akurat apakah pengirim adalah Owner atau Nomor Bot sendiri
 */
function isOwner(msg, sock) {
    // 1. Pesan dari akun bot sendiri selalu diizinkan
    if (msg.key?.fromMe) return true;

    // 2. Cek nomor pengirim apakah sama dengan nomor bot
    const senderNum = getSenderNumber(msg, sock);
    const botNum = extractNumberFromJid(sock?.user?.id || '');
    if (botNum && senderNum === botNum) return true;

    // 3. Cek apakah nomor/LID terdaftar di OWNER_NUMBERS
    if (OWNER_NUMBERS.includes(senderNum)) return true;

    // 4. Cek identifier mentah (remoteJid / participant)
    const remoteJid = msg.key?.remoteJid || '';
    const participant = msg.key?.participant || '';
    for (const ownerId of OWNER_NUMBERS) {
        if (remoteJid.includes(ownerId) || participant.includes(ownerId)) {
            return true;
        }
    }

    return false;
}

/**
 * Membuat buffer EXIF metadata untuk stiker WhatsApp dengan nama TeamLoLoK
 */
function createStickerExif(packName = 'TeamLoLoK', author = 'TeamLoLoK') {
    const json = {
        'sticker-pack-name': packName,
        'sticker-pack-publisher': author,
        'emojis': ['✨', '🔥']
    };
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf-8');
    const exifHeader = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    exifHeader.writeUInt32LE(jsonBuffer.length, 14);
    return Buffer.concat([exifHeader, jsonBuffer]);
}

/**
 * Konversi Buffer Gambar ke Stiker WebP Full Frame (512x512 tanpa spacing/border hitam)
 */
async function convertImageToSticker(imageBuffer, packName = 'TeamLoLoK', author = 'TeamLoLoK') {
    const randomId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tmpInput = path.join(os.tmpdir(), `img_in_${randomId}.jpg`);
    const tmpWebp = path.join(os.tmpdir(), `img_mid_${randomId}.webp`);
    const tmpExif = path.join(os.tmpdir(), `img_exif_${randomId}.exif`);
    const tmpFinal = path.join(os.tmpdir(), `img_out_${randomId}.webp`);

    try {
        await fs.writeFile(tmpInput, imageBuffer);
        const exifBuffer = createStickerExif(packName, author);
        await fs.writeFile(tmpExif, exifBuffer);

        // FFmpeg: scale & center-crop (fill 100% canvas 512x512 tanpa spasi/garis tepi hitam)
        await execFilePromise('ffmpeg', [
            '-y',
            '-i', tmpInput,
            '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-compression_level', '6',
            '-q:v', '75',
            tmpWebp
        ]);

        try {
            await execFilePromise('webpmux', ['-set', 'exif', tmpExif, tmpWebp, '-o', tmpFinal]);
            return await fs.readFile(tmpFinal);
        } catch {
            return await fs.readFile(tmpWebp);
        }
    } finally {
        await fs.unlink(tmpInput).catch(() => {});
        await fs.unlink(tmpWebp).catch(() => {});
        await fs.unlink(tmpExif).catch(() => {});
        await fs.unlink(tmpFinal).catch(() => {});
    }
}

/**
 * Konversi Buffer Video/GIF ke Stiker Animasi WebP Full Frame (512x512 tanpa spacing/border hitam)
 */
async function convertVideoToSticker(videoBuffer, packName = 'TeamLoLoK', author = 'TeamLoLoK') {
    const randomId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tmpInput = path.join(os.tmpdir(), `vid_in_${randomId}.mp4`);
    const tmpWebp = path.join(os.tmpdir(), `vid_mid_${randomId}.webp`);
    const tmpExif = path.join(os.tmpdir(), `vid_exif_${randomId}.exif`);
    const tmpFinal = path.join(os.tmpdir(), `vid_out_${randomId}.webp`);

    try {
        await fs.writeFile(tmpInput, videoBuffer);
        const exifBuffer = createStickerExif(packName, author);
        await fs.writeFile(tmpExif, exifBuffer);

        // FFmpeg: scale & center-crop (fill 100% canvas 512x512, maks 7 detik, 12 FPS)
        await execFilePromise('ffmpeg', [
            '-y',
            '-i', tmpInput,
            '-t', '7',
            '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=12',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-compression_level', '6',
            '-q:v', '40',
            '-loop', '0',
            '-an',
            '-vsync', '0',
            tmpWebp
        ]);

        try {
            await execFilePromise('webpmux', ['-set', 'exif', tmpExif, tmpWebp, '-o', tmpFinal]);
            return await fs.readFile(tmpFinal);
        } catch {
            return await fs.readFile(tmpWebp);
        }
    } finally {
        await fs.unlink(tmpInput).catch(() => {});
        await fs.unlink(tmpWebp).catch(() => {});
        await fs.unlink(tmpExif).catch(() => {});
        await fs.unlink(tmpFinal).catch(() => {});
    }
}

/**
 * Konversi Buffer Stiker WebP ke Foto (PNG) atau Video (MP4 jika bergerak/animasi)
 */
async function convertStickerToSource(stickerBuffer, isAnimated = false) {
    const randomId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tmpInput = path.join(os.tmpdir(), `stk_in_${randomId}.webp`);

    try {
        await fs.writeFile(tmpInput, stickerBuffer);

        // Periksa apakah stiker beranimasi jika flag isAnimated belum diset
        let animated = isAnimated;
        if (!animated) {
            const rawStr = stickerBuffer.toString('binary');
            if (rawStr.includes('ANIM') || rawStr.includes('ANMF')) {
                animated = true;
            }
        }

        if (animated) {
            const tmpOutput = path.join(os.tmpdir(), `stk_out_${randomId}.mp4`);
            try {
                // Konversi WebP Animasi -> MP4 Video (H.264, yuv420p, dimensi genap)
                await execFilePromise('ffmpeg', [
                    '-y',
                    '-i', tmpInput,
                    '-pix_fmt', 'yuv420p',
                    '-c:v', 'libx264',
                    '-movflags', '+faststart',
                    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                    tmpOutput
                ]);
                const videoBuffer = await fs.readFile(tmpOutput);
                await fs.unlink(tmpOutput).catch(() => {});
                return { buffer: videoBuffer, isVideo: true, mimetype: 'video/mp4' };
            } catch (err) {
                console.error('[!] Gagal encode animated sticker ke MP4, mencoba fallback ke PNG:', err?.message || err);
            }
        }

        // Konversi WebP Statis -> Foto PNG
        const tmpOutput = path.join(os.tmpdir(), `stk_out_${randomId}.png`);
        await execFilePromise('ffmpeg', [
            '-y',
            '-i', tmpInput,
            tmpOutput
        ]);
        const imageBuffer = await fs.readFile(tmpOutput);
        await fs.unlink(tmpOutput).catch(() => {});
        return { buffer: imageBuffer, isVideo: false, mimetype: 'image/png' };
    } finally {
        await fs.unlink(tmpInput).catch(() => {});
    }
}

/**
 * Handle Anti-Delete: Meneruskan pesan yang dihapus ke nomor privat tujuan (6285143666343)
 */
async function handleDeletedMessage(sock, msg, protocolMessage) {
    try {
        const deletedId = protocolMessage.key?.id;
        if (!deletedId || !messageStore.has(deletedId)) return;

        const savedData = messageStore.get(deletedId);
        const originChatJid = msg.key.remoteJid;
        const senderJid = savedData.key?.participant || savedData.key?.remoteJid || protocolMessage.key?.participant;
        const senderNumber = extractNumberFromJid(senderJid) || 'Seseorang';
        const pushName = savedData.pushName || 'User';
        const isGroup = originChatJid.endsWith('@g.us');

        // Abaikan jika pesan yang dihapus berasal dari bot sendiri
        if (savedData.key?.fromMe) return;

        console.log(`[🗑️ Anti-Delete] Pesan ${deletedId} dihapus oleh @${senderNumber} di ${originChatJid}, meneruskan ke ${FORWARD_ANTI_DELETE_JID}`);

        const innerMsg =
            savedData.message?.ephemeralMessage?.message ||
            savedData.message?.viewOnceMessage?.message ||
            savedData.message?.viewOnceMessageV2?.message ||
            savedData.message?.viewOnceMessageV2Extension?.message ||
            savedData.message;

        if (!innerMsg) return;

        const chatLocation = isGroup ? `Grup (${originChatJid})` : `Chat Pribadi (@${extractNumberFromJid(originChatJid)})`;
        const timeString = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        const header = `🗑️ *[ANTI-DELETE FORWARD]*\n` +
                       `👤 *Pengirim:* @${senderNumber} (${pushName})\n` +
                       `📍 *Asal Chat:* ${chatLocation}\n` +
                       `⏰ *Waktu:* ${timeString}\n`;

        // 1. Teks Biasa
        const textContent = innerMsg.conversation || innerMsg.extendedTextMessage?.text;
        if (textContent) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                text: `${header}\n💬 *Isi Pesan:*\n${textContent}`,
                mentions: [senderJid]
            });
            return;
        }

        // 2. Pesan Media (Gambar, Video, Audio, Stiker)
        const mediaBuffer = await downloadMediaMessage(
            { key: savedData.key, message: innerMsg },
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        ).catch(() => null);

        if (!mediaBuffer) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                text: `${header}\n⚠️ _(Pesan media yang dihapus tidak dapat diunduh/kadaluarsa)_`,
                mentions: [senderJid]
            });
            return;
        }

        if (innerMsg.imageMessage) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                image: mediaBuffer,
                caption: `${header}\n📸 *Foto yang dihapus*`,
                mentions: [senderJid]
            });
        } else if (innerMsg.videoMessage) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                video: mediaBuffer,
                caption: `${header}\n🎥 *Video yang dihapus*`,
                mentions: [senderJid]
            });
        } else if (innerMsg.audioMessage) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                text: `${header}\n🎙️ *Voice Note / Audio yang dihapus:*`,
                mentions: [senderJid]
            });
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                audio: mediaBuffer,
                mimetype: innerMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                ptt: innerMsg.audioMessage.ptt ?? true
            });
        } else if (innerMsg.stickerMessage) {
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                text: `${header}\n🖼️ *Stiker yang dihapus:*`,
                mentions: [senderJid]
            });
            await sock.sendMessage(FORWARD_ANTI_DELETE_JID, {
                sticker: mediaBuffer
            });
        }
    } catch (err) {
        console.error('[!] Error saat memproses Anti-Delete Forward:', err?.message || err);
    }
}

/**
 * Handle Download TikTok (No Watermark & Slide Photos)
 */
async function handleTikTokDownload(sock, chatJid, msg, url) {
    try {
        await sock.sendMessage(chatJid, { text: '⏳ Sedang memproses download TikTok...' }, { quoted: msg });
        const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
        const json = await res.json();

        if (json.code === 0 && json.data) {
            const data = json.data;
            const caption = `🎬 *TikTok Downloader*\n\n` +
                            `👤 *Author:* ${data.author?.nickname || data.author?.unique_id || '-'}\n` +
                            `📝 *Judul:* ${data.title || '-'}\n` +
                            `🎵 *Musik:* ${data.music_info?.title || '-'}`;

            if (data.images && data.images.length > 0) {
                for (let i = 0; i < data.images.length; i++) {
                    await sock.sendMessage(chatJid, {
                        image: { url: data.images[i] },
                        caption: i === 0 ? caption : undefined
                    }, { quoted: i === 0 ? msg : undefined });
                }
                return true;
            }

            const videoUrl = data.hdplay || data.play;
            if (videoUrl) {
                await sock.sendMessage(chatJid, {
                    video: { url: videoUrl },
                    caption: caption,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
                return true;
            }
        }
    } catch (e) {
        console.log('[!] TikWM error, mencoba fallback yt-dlp:', e?.message || e);
    }

    return await handleYtDlpDownload(sock, chatJid, msg, url, false, 'TikTok');
}

/**
 * Handle Universal Downloader (YouTube, Instagram, Facebook, X, etc.) menggunakan yt-dlp
 */
async function handleYtDlpDownload(sock, chatJid, msg, url, isAudio = false, platformName = 'Media') {
    await sock.sendMessage(chatJid, { text: `⏳ Sedang mengunduh ${platformName} (${isAudio ? 'Audio MP3' : 'Video'})...\n_Mohon tunggu sebentar..._` }, { quoted: msg });

    const randomId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const outputTemplate = path.join(os.tmpdir(), `ytdl_${randomId}.%(ext)s`);

    const args = isAudio
        ? [
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--max-filesize', '50M',
            '-o', outputTemplate,
            '--no-playlist',
            url
        ]
        : [
            '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
            '--merge-output-format', 'mp4',
            '--max-filesize', '70M',
            '-o', outputTemplate,
            '--no-playlist',
            url
        ];

    try {
        await execFilePromise('yt-dlp', args);
        const files = await fs.readdir(os.tmpdir());
        const downloadedFile = files.find(f => f.startsWith(`ytdl_${randomId}.`));

        if (downloadedFile) {
            const filePath = path.join(os.tmpdir(), downloadedFile);
            const buffer = await fs.readFile(filePath);
            await fs.unlink(filePath).catch(() => {});

            if (isAudio || downloadedFile.endsWith('.mp3') || downloadedFile.endsWith('.m4a')) {
                await sock.sendMessage(chatJid, {
                    audio: buffer,
                    mimetype: 'audio/mp4',
                    ptt: false
                }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, {
                    video: buffer,
                    caption: `🎬 *${platformName} Downloader*\n✅ Berhasil diunduh!`,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
            }
            return true;
        } else {
            await sock.sendMessage(chatJid, { text: `❌ Gagal mengunduh media. Pastikan link publik dan berdurasi wajar.` }, { quoted: msg });
            return false;
        }
    } catch (err) {
        console.error('[!] yt-dlp error:', err?.message || err);
        const shortError = err?.message?.split('\n')[0] || 'Gagal memproses media.';
        await sock.sendMessage(chatJid, { text: `❌ Gagal download: ${shortError}` }, { quoted: msg });
        return false;
    }
}

async function startBot() {
    // 1. Inisialisasi Multi File Auth State untuk menyimpan sesi ke disk
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`[i] Memuat Baileys v${version.join('.')} (Latest: ${isLatest})`);

    // Jika belum login / terdaftar, tanyakan metode autentikasi yang diinginkan
    if (!state.creds.registered) {
        const envPairingNumber = process.env.PAIRING_NUMBER || process.env.PHONE_NUMBER;
        const envUsePairing = process.env.USE_PAIRING === 'true' || Boolean(envPairingNumber);

        if (envUsePairing && envPairingNumber) {
            usePairingCode = true;
            phoneNumber = envPairingNumber.replace(/[^0-9]/g, '');
            console.log(`[i] Menggunakan Pairing Code dari Environment Variable untuk nomor: ${phoneNumber}`);
        } else if (!process.stdin.isTTY) {
            console.log('[i] Terdeteksi lingkungan Server / Docker / Railway (Non-Interactive TTY).');
            console.log('[i] Menampilkan QR Code di log console. (Tip: Set env PAIRING_NUMBER jika ingin Pairing Code)');
            usePairingCode = false;
        } else {
            console.log('\n=========================================');
            console.log('       PILIHAN METODE AUTENTIKASI        ');
            console.log('=========================================');
            console.log('1. QR Code');
            console.log('2. Pairing Code');
            console.log('=========================================');

            const choice = (await askQuestion('Pilih metode login (1/2): ')).trim();

            if (choice === '2') {
                usePairingCode = true;
                const inputNumber = await askQuestion('Masukkan nomor WhatsApp Anda (contoh: 6281234567890): ');
                phoneNumber = inputNumber.replace(/[^0-9]/g, '');

                if (!phoneNumber) {
                    console.log('[!] Nomor tidak valid! Mengalihkan otomatis ke metode QR Code.');
                    usePairingCode = false;
                }
            } else {
                usePairingCode = false;
            }
        }
    }

    // 2. Buat koneksi Socket Baileys dengan getMessage & msgRetryCounterCache
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        getMessage: async (key) => {
            if (messageStore.has(key.id)) {
                return messageStore.get(key.id).message;
            }
            return {
                conversation: ''
            };
        },
        msgRetryCounterCache: {
            get: (key) => msgRetryCounterCache.get(key),
            set: (key, val) => msgRetryCounterCache.set(key, val),
            del: (key) => msgRetryCounterCache.delete(key)
        }
    });

    // Handle request Pairing Code jika dipilih oleh user
    if (usePairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log('\n=========================================');
                console.log(`  KODE PAIRING ANDA: ${formattedCode}`);
                console.log('=========================================');
                console.log('Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon.\n');
            } catch (err) {
                console.error('[!] Gagal meminta Pairing Code:', err?.message || err);
            }
        }, 3000);
    }

    // 3. Event Listener: Update Koneksi & Auto-Reconnect
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
            console.log('\n[!] Silakan scan QR Code di bawah menggunakan WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : lastDisconnect?.error?.output?.statusCode;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[!] Koneksi terputus. Status Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                console.log('[*] Menghubungkan ulang ke WhatsApp...');
                setTimeout(startBot, 3000);
            } else {
                console.log('[!] Sesi telah logout. Silakan hapus folder "auth_session" dan login kembali.');
                process.exit(0);
            }
        } else if (connection === 'open') {
            console.log('\n[✓] WhatsApp Bot BERHASIL TERHUBUNG (GHOST / PRIVATE MODE)!');
            console.log(`[✓] Eksklusif Owner : ${OWNER_MAIN_NUMBER} (LID: 14470281740424) & Akun Bot`);
            console.log('[✓] Fitur Aktif:');
            console.log('    1. Anti View-Once : .fuckyou / .doksli');
            console.log('    2. Sticker Maker  : .s (Pack: TeamLoLoK)');
            console.log('    3. Sticker to Src : .tosource / .toimg / .tovid');
            console.log(`    4. Anti Delete    : Private Forward ke ${OWNER_MAIN_NUMBER}`);
            console.log('    5. Downloader     : .tt, .ig, .yt, .ytmp3, .fb, .dl');
            console.log('    [!] Mode Silent   : Bot 100% tidak akan merespons siapa pun selain Owner & Bot sendiri.\n');
        }
    });

    // Simpan kredensial sesi jika terjadi pembaruan
    sock.ev.on('creds.update', saveCreds);

    // 4. Event Listener: Memproses Pesan Masuk (messages.upsert)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message || !msg.key?.id) continue;

                // Unwrap pesan jika berada di dalam ephemeralMessage wrapper
                const realMessage =
                    msg.message.ephemeralMessage?.message ||
                    msg.message;

                // FITUR ANTI-DELETE: Selalu aktif di latar belakang (meneruskan pesan yang dihapus ke Owner secara privat)
                if (realMessage.protocolMessage && realMessage.protocolMessage.type === 0) {
                    await handleDeletedMessage(sock, msg, realMessage.protocolMessage);
                    continue;
                }

                // Simpan pesan baru ke memory store untuk Anti-Delete & Signal Retry
                messageStore.set(msg.key.id, {
                    key: msg.key,
                    message: msg.message,
                    pushName: msg.pushName || 'User',
                    timestamp: msg.messageTimestamp
                });

                if (messageStore.size > 2000) {
                    const oldest = messageStore.keys().next().value;
                    messageStore.delete(oldest);
                }

                // Ambil teks pesan baik dari conversation, caption, maupun extendedTextMessage
                const messageText = (
                    realMessage.conversation ||
                    realMessage.imageMessage?.caption ||
                    realMessage.videoMessage?.caption ||
                    realMessage.extendedTextMessage?.text ||
                    ''
                ).trim();

                const parts = messageText.split(/\s+/);
                const command = parts[0].toLowerCase();
                const argsText = parts.slice(1).join(' ').trim();

                const knownCommands = [
                    '.fuckyou', '.doksli',
                    '.s', '.sticker', '.sgif',
                    '.tosource', '.toimg', '.tovid',
                    '.dl', '.download',
                    '.tt', '.tiktok',
                    '.ig', '.instagram',
                    '.yt', '.ytmp4', '.ytmp3', '.ytaudio',
                    '.fb', '.facebook'
                ];

                if (!knownCommands.includes(command)) continue;

                // DEDUPLIKASI PESAN: Cegah eksekusi ganda jika Baileys mengirim event duplikat untuk ID pesan yang sama
                if (markMessageProcessed(msg.key.id)) {
                    continue;
                }

                const chatJid = msg.key.remoteJid;
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const senderNumber = getSenderNumber(msg, sock);
                const isOwnerUser = isOwner(msg, sock);
                const contextInfo = realMessage.extendedTextMessage?.contextInfo;
                const quotedMsg = contextInfo?.quotedMessage;

                /* =========================================================================
                 * GHOST MODE: BOT 100% TIDAK MERESPONS SIAPA PUN SELAIN OWNER & NOMOR BOT
                 * ========================================================================= */
                if (!isOwnerUser) {
                    console.log(`[!] Mengabaikan perintah ${command} dari non-owner @${senderNumber} (100% Silent Ignore)`);
                    continue; // Benar-benar diam tanpa memberikan respons atau pesan apa pun
                }

                console.log(`[*] Perintah ${command} diterima dari Owner: ${senderJid} (ID: ${senderNumber})`);

                /* =========================================================================
                 * FITUR 1: ANTI VIEW-ONCE (.fuckyou / .doksli)
                 * ========================================================================= */
                if (command === '.fuckyou' || command === '.doksli') {
                    if (!contextInfo || !quotedMsg) continue;

                    const viewOnceContainer =
                        quotedMsg.viewOnceMessage?.message ||
                        quotedMsg.viewOnceMessageV2?.message ||
                        quotedMsg.viewOnceMessageV2Extension?.message;

                    const mediaMessage = viewOnceContainer || (
                        (quotedMsg.imageMessage?.viewOnce || quotedMsg.videoMessage?.viewOnce || quotedMsg.audioMessage?.viewOnce)
                            ? quotedMsg
                            : null
                    );

                    if (!mediaMessage) continue;

                    console.log(`[*] Pesan View-Once diekstrak oleh Owner di: ${chatJid}`);

                    const quotedSender = contextInfo.participant || msg.key.participant || msg.key.remoteJid;
                    const fakeWAMessage = {
                        key: {
                            remoteJid: chatJid,
                            id: contextInfo.stanzaId,
                            participant: quotedSender,
                            fromMe: false
                        },
                        message: mediaMessage
                    };

                    const mediaBuffer = await downloadMediaMessage(
                        fakeWAMessage,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );

                    if (!mediaBuffer) continue;

                    if (mediaMessage.imageMessage) {
                        await sock.sendMessage(
                            chatJid,
                            {
                                image: mediaBuffer,
                                viewOnce: false,
                                mimetype: mediaMessage.imageMessage.mimetype || 'image/jpeg'
                            },
                            { quoted: msg }
                        );
                    } else if (mediaMessage.videoMessage) {
                        await sock.sendMessage(
                            chatJid,
                            {
                                video: mediaBuffer,
                                viewOnce: false,
                                mimetype: mediaMessage.videoMessage.mimetype || 'video/mp4'
                            },
                            { quoted: msg }
                        );
                    } else if (mediaMessage.audioMessage) {
                        await sock.sendMessage(
                            chatJid,
                            {
                                audio: mediaBuffer,
                                mimetype: mediaMessage.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                                ptt: mediaMessage.audioMessage.ptt ?? false
                            },
                            { quoted: msg }
                        );
                    }

                    console.log(`[✓] Berhasil mengekstrak & mengirim ulang View-Once ke ${chatJid} (Tanpa Caption)`);
                    continue;
                }

                /* =========================================================================
                 * FITUR 2: STICKER / GIF MAKER (.s) - TeamLoLoK
                 * ========================================================================= */
                if (command === '.s' || command === '.sticker' || command === '.sgif') {
                    let mediaBuffer = null;
                    let isVideo = false;

                    // Kasus A: Reply ke pesan gambar atau video
                    if (quotedMsg) {
                        const unwrapQuoted =
                            quotedMsg.viewOnceMessage?.message ||
                            quotedMsg.viewOnceMessageV2?.message ||
                            quotedMsg.viewOnceMessageV2Extension?.message ||
                            quotedMsg;

                        if (unwrapQuoted.imageMessage) {
                            isVideo = false;
                            const quotedSender = contextInfo.participant || msg.key.participant || msg.key.remoteJid;
                            mediaBuffer = await downloadMediaMessage(
                                {
                                    key: { remoteJid: chatJid, id: contextInfo.stanzaId, participant: quotedSender, fromMe: false },
                                    message: unwrapQuoted
                                },
                                'buffer',
                                {},
                                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                            );
                        } else if (unwrapQuoted.videoMessage) {
                            isVideo = true;
                            if (unwrapQuoted.videoMessage.seconds > 10) {
                                await sock.sendMessage(chatJid, { text: '⚠️ Durasi video terlalu panjang! Maksimal 10 detik untuk stiker animasi.' }, { quoted: msg });
                                continue;
                            }
                            const quotedSender = contextInfo.participant || msg.key.participant || msg.key.remoteJid;
                            mediaBuffer = await downloadMediaMessage(
                                {
                                    key: { remoteJid: chatJid, id: contextInfo.stanzaId, participant: quotedSender, fromMe: false },
                                    message: unwrapQuoted
                                },
                                'buffer',
                                {},
                                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                            );
                        }
                    }
                    // Kasus B: Mengirim gambar/video langsung dengan caption .s
                    else if (realMessage.imageMessage) {
                        isVideo = false;
                        mediaBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        );
                    } else if (realMessage.videoMessage) {
                        isVideo = true;
                        if (realMessage.videoMessage.seconds > 10) {
                            await sock.sendMessage(chatJid, { text: '⚠️ Durasi video terlalu panjang! Maksimal 10 detik untuk stiker animasi.' }, { quoted: msg });
                            continue;
                        }
                        mediaBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        );
                    }

                    if (!mediaBuffer) {
                        await sock.sendMessage(chatJid, { text: '⚠️ Kirim foto/video dengan caption *.s* atau reply foto/video dengan *.s* untuk dijadikan stiker!' }, { quoted: msg });
                        continue;
                    }

                    console.log(`[*] Mengonversi media ke stiker Full Frame (${isVideo ? 'Video/GIF' : 'Foto'})...`);

                    let stickerWebpBuffer;
                    if (isVideo) {
                        stickerWebpBuffer = await convertVideoToSticker(mediaBuffer, 'TeamLoLoK', 'TeamLoLoK');
                    } else {
                        stickerWebpBuffer = await convertImageToSticker(mediaBuffer, 'TeamLoLoK', 'TeamLoLoK');
                    }

                    if (stickerWebpBuffer) {
                        await sock.sendMessage(
                            chatJid,
                            { sticker: stickerWebpBuffer },
                            { quoted: msg }
                        );
                        console.log(`[✓] Stiker TeamLoLoK berhasil dikirim ke ${chatJid}`);
                    } else {
                        await sock.sendMessage(chatJid, { text: '❌ Gagal membuat stiker dari media tersebut.' }, { quoted: msg });
                    }
                    continue;
                }

                /* =========================================================================
                 * FITUR 3: STICKER TO SOURCE (.tosource / .toimg / .tovid)
                 * ========================================================================= */
                if (command === '.tosource' || command === '.toimg' || command === '.tovid') {
                    if (!contextInfo || !quotedMsg) {
                        await sock.sendMessage(chatJid, {
                            text: '⚠️ Balas / reply stiker yang ingin diubah ke foto/video dengan *.tosource*'
                        }, { quoted: msg });
                        continue;
                    }

                    const unwrapQuoted =
                        quotedMsg.viewOnceMessage?.message ||
                        quotedMsg.viewOnceMessageV2?.message ||
                        quotedMsg.viewOnceMessageV2Extension?.message ||
                        quotedMsg;

                    const stickerMsg = unwrapQuoted.stickerMessage;
                    if (!stickerMsg) {
                        await sock.sendMessage(chatJid, {
                            text: '⚠️ Pesan yang dibalas bukan stiker! Harap reply pesan stiker dengan *.tosource*'
                        }, { quoted: msg });
                        continue;
                    }

                    console.log(`[*] Mengunduh & mengonversi stiker ke sumber asli untuk chat: ${chatJid}...`);
                    const quotedSender = contextInfo.participant || msg.key.participant || msg.key.remoteJid;

                    const stickerBuffer = await downloadMediaMessage(
                        {
                            key: { remoteJid: chatJid, id: contextInfo.stanzaId, participant: quotedSender, fromMe: false },
                            message: unwrapQuoted
                        },
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    ).catch(() => null);

                    if (!stickerBuffer) {
                        await sock.sendMessage(chatJid, { text: '❌ Gagal mengunduh stiker. Coba ulangi beberapa saat lagi.' }, { quoted: msg });
                        continue;
                    }

                    const isAnimated = stickerMsg.isAnimated === true;
                    const result = await convertStickerToSource(stickerBuffer, isAnimated).catch((err) => {
                        console.error('[!] Error convert sticker to source:', err?.message || err);
                        return null;
                    });

                    if (!result || !result.buffer) {
                        await sock.sendMessage(chatJid, { text: '❌ Gagal mengonversi stiker ke foto/video.' }, { quoted: msg });
                        continue;
                    }

                    if (result.isVideo) {
                        await sock.sendMessage(
                            chatJid,
                            {
                                video: result.buffer,
                                caption: '🎥 *Sticker to Video*',
                                mimetype: 'video/mp4'
                            },
                            { quoted: msg }
                        );
                        console.log(`[✓] Berhasil mengirim video hasil konversi stiker ke ${chatJid}`);
                    } else {
                        await sock.sendMessage(
                            chatJid,
                            {
                                image: result.buffer,
                                caption: '📸 *Sticker to Photo*',
                                mimetype: 'image/png'
                            },
                            { quoted: msg }
                        );
                        console.log(`[✓] Berhasil mengirim foto hasil konversi stiker ke ${chatJid}`);
                    }
                    continue;
                }

                /* =========================================================================
                 * FITUR 4: DOWNLOADER (TikTok, IG, YouTube, Facebook, X, etc.)
                 * ========================================================================= */
                const isDownloaderCommand = [
                    '.dl', '.download',
                    '.tt', '.tiktok',
                    '.ig', '.instagram',
                    '.yt', '.ytmp4', '.ytmp3', '.ytaudio',
                    '.fb', '.facebook'
                ].includes(command);

                if (isDownloaderCommand) {
                    const targetUrl = argsText || (quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '');
                    
                    if (!targetUrl || !targetUrl.startsWith('http')) {
                        await sock.sendMessage(chatJid, {
                            text: `⚠️ *Format Perintah Downloader Salah!*\n\n` +
                                  `Contoh Penggunaan:\n` +
                                  `• *${command} https://vt.tiktok.com/xxxx/*\n` +
                                  `• *${command} https://www.instagram.com/reel/xxxx/*\n` +
                                  `• *${command} https://youtu.be/xxxx/*`
                        }, { quoted: msg });
                        continue;
                    }

                    console.log(`[*] Memproses download: ${command} -> ${targetUrl}`);

                    // 1. TikTok Downloader
                    if (command === '.tt' || command === '.tiktok' || targetUrl.includes('tiktok.com')) {
                        await handleTikTokDownload(sock, chatJid, msg, targetUrl);
                    }
                    // 2. Instagram Downloader
                    else if (command === '.ig' || command === '.instagram' || targetUrl.includes('instagram.com')) {
                        await handleYtDlpDownload(sock, chatJid, msg, targetUrl, false, 'Instagram');
                    }
                    // 3. YouTube Audio (MP3)
                    else if (command === '.ytmp3' || command === '.ytaudio') {
                        await handleYtDlpDownload(sock, chatJid, msg, targetUrl, true, 'YouTube MP3');
                    }
                    // 4. YouTube Video (MP4)
                    else if (command === '.yt' || command === '.ytmp4' || targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
                        await handleYtDlpDownload(sock, chatJid, msg, targetUrl, false, 'YouTube Video');
                    }
                    // 5. Facebook Downloader
                    else if (command === '.fb' || command === '.facebook' || targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
                        await handleYtDlpDownload(sock, chatJid, msg, targetUrl, false, 'Facebook');
                    }
                    // 6. Universal Downloader (.dl / .download)
                    else {
                        await handleYtDlpDownload(sock, chatJid, msg, targetUrl, false, 'Media');
                    }
                }

            } catch (err) {
                console.error('[!] Error saat memproses pesan:', err?.message || err);
            }
        }
    });
}

// Jalankan bot
startBot().catch((err) => {
    console.error('[!] Fatal Error saat inisialisasi bot:', err);
});
