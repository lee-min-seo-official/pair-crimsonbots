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
    DisconnectReason
} = require('baileys');
const { upload } = require('./mega');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');

const app = express();
const port = 3000;
let session;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();

app.use(express.static(path.join(__dirname, 'static')));

async function connector(Num, res) {
    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'fatal' })
            )
        },
        logger: pino({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        Num = Num.replace(/[^0-9]/g, '');
        const code = await session.requestPairingCode(Num);
        if (!res.headersSent) {
            res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
        }
    }

    session.ev.on('creds.update', saveCreds);

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('Connected successfully');

            await delay(5000);

            const myr = await session.sendMessage(session.user.id, {
                text: config.MESSAGE
            });

            const pth = './session/creds.json';

            try {
                const url = await upload(pth);

                let sID;
                if (url.includes("https://mega.nz/file/")) {
                    sID = config.PREFIX + url.split("https://mega.nz/file/")[1];
                } else {
                    sID = "UPLOAD_FAILED";
                }

                await session.sendMessage(
                    session.user.id,
                    {
                        image: { url: config.IMAGE },
                        caption: `*Session ID*\n\n${sID}`
                    },
                    { quoted: myr }
                );
            } catch (err) {
                console.error("Upload error:", err);
            }

            // Safe cleanup AFTER everything is done
            setTimeout(() => {
                try {
                    session.end();
                    fs.rmSync('./session', { recursive: true, force: true });
                    console.log("Session closed and cleaned safely");
                } catch (e) {
                    console.error("Cleanup failed:", e);
                }
            }, 4000);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            reconn(reason);
        }
    });
}

function reconn(reason) {
    if (
        [DisconnectReason.connectionLost,
         DisconnectReason.connectionClosed,
         DisconnectReason.restartRequired].includes(reason)
    ) {
        console.log("Connection lost, reconnecting...");
        connector();
    } else if (reason === 401 || reason === DisconnectReason.loggedOut) {
        console.log("Pairing device logged out (normal). Waiting for next request.");
    } else {
        console.log("Disconnected:", reason);
    }
}

app.get('/pair', async (req, res) => {
    const Num = req.query.code;
    if (!Num) return res.status(418).json({ message: 'Phone number is required' });

    const release = await mutex.acquire();
    try {
        await connector(Num, res);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal error" });
    } finally {
        release();
    }
});

app.listen(port, () => {
    console.log(`Running on PORT:${port}`);
});
