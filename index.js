const express = require('express');
const fs = require('fs');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const { upload } = require('./mega');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');

var app = express();
var port = 3000;
var session;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();

app.use(express.static(path.join(__dirname, 'static')));

function cleanSession() {
    var sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

async function connector(Num, res) {
    // Wipe any stale session — critical to avoid 405
    cleanSession();
    fs.mkdirSync(path.join(__dirname, 'session'));

    const { version } = await fetchLatestBaileysVersion();
    console.log('Using WA version:', version.join('.'));

    var { state, saveCreds } = await useMultiFileAuthState('./session');

    session = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'fatal' }).child({ level: 'fatal' })
            )
        },
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        Num = Num.replace(/[^0-9]/g, '');
        console.log('Requesting pairing code for:', Num);
        var code = await session.requestPairingCode(Num);
        console.log('Got code:', code);
        if (!res.headersSent) {
            res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
        }
    }

    session.ev.on('creds.update', async () => {
        await saveCreds();
    });

    session.ev.on('connection.update', async (update) => {
        var { connection, lastDisconnect } = update;
        console.log('connection.update:', connection, lastDisconnect?.error?.message || '');

        if (connection === 'open') {
            console.log('Connected successfully');
            await delay(5000);

            var myr = await session.sendMessage(session.user.id, {
                text: `${config.MESSAGE}`
            });

            var pth = './session/creds.json';

            try {
                var url = await upload(pth);
                var sID;
                if (url.includes('https://mega.nz/file/')) {
                    sID = config.PREFIX + url.split('https://mega.nz/file/')[1];
                } else {
                    sID = 'Fekd up';
                }

                await session.sendMessage(
                    session.user.id,
                    {
                        image: { url: `${config.IMAGE}` },
                        caption: `*Session ID*\n\n${sID}`
                    },
                    { quoted: myr }
                );
            } catch (error) {
                console.error('Upload/send error:', error);
            } finally {
                cleanSession();
            }

        } else if (connection === 'close') {
            var reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Close reason code:', reason);
            reconn(reason);
        }
    });
}

function reconn(reason) {
    if ([
        DisconnectReason.connectionLost,
        DisconnectReason.connectionClosed,
        DisconnectReason.restartRequired
    ].includes(reason)) {
        console.log('Connection lost, reconnecting...');
        connector();
    } else {
        console.log(`Disconnected! reason: ${reason}`);
        if (session) session.end();
    }
}

app.get('/pair', async (req, res) => {
    var Num = req.query.code;
    if (!Num) {
        return res.status(418).json({ message: 'Phone number is required' });
    }

    var release = await mutex.acquire();
    try {
        await connector(Num, res);
    } catch (error) {
        console.error('Connector error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'fekd up' });
        }
    } finally {
        release();
    }
});

app.listen(port, () => {
    console.log(`Running on PORT:${port}`);
});
