const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BUILD_DATE = "March 22, 2026";
const PORT = 3000;
const configPath = path.join(process.cwd(), 'config.txt');

let TWITCH_CHANNEL = 'twitch', YOUTUBE_ID = '', YOUTUBE_DISPLAY_NAME = '';
let emoteMap = {}, badgeMap = {}, tmiClient = null, ytChat = null;

// ERROR LOGGING
process.on('unhandledRejection', (reason) => console.error('LOG: YouTube rejected the request. Is the stream live?'));

function saveConfig() {
    try { fs.writeFileSync(configPath, JSON.stringify({ twitch: TWITCH_CHANNEL, youtube: YOUTUBE_ID, youtubeName: YOUTUBE_DISPLAY_NAME }), 'utf8'); } catch (e) {}
}

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            TWITCH_CHANNEL = d.twitch || 'twitch';
            YOUTUBE_ID = d.youtube || '';
            YOUTUBE_DISPLAY_NAME = d.youtubeName || d.youtube || '';
        }
    } catch (e) {}
}

async function getYoutubeId(input) {
    if (!input) return null;
    const clean = input.trim();
    // If it's already a UC ID, return it
    if (clean.startsWith('UC') && clean.length === 24) return { id: clean, name: clean };
    
    try {
        const url = clean.startsWith('http') ? clean : (clean.startsWith('@') ? `https://www.youtube.com/${clean}` : `https://www.youtube.com/@${clean}`);
        console.log(`🔍 Resolving YouTube ID for: ${url}`);
        const res = await fetch(url);
        const html = await res.text();
        const idMatch = html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/);
        const nameMatch = html.match(/"name":"([^"]+)"/);
        
        if (!idMatch) console.log("⚠️ Could not find UC ID in the page HTML.");
        return idMatch ? { id: idMatch[1], name: nameMatch ? nameMatch[1] : clean } : null;
    } catch (e) { 
        console.error("❌ Resolution error:", e.message);
        return null; 
    }
}

function connectYouTube(id) {
    if (ytChat) try { ytChat.stop(); } catch(e) {}
    if (!id) return io.emit('status-update', { platform: 'youtube', connected: false });

    console.log(`📡 Connecting to Live Chat for ID: ${id}`);
    try {
        ytChat = new LiveChat({ channelId: id });
        
        ytChat.on("chat", (item) => {
            const txt = item.message.map(m => m.text || '').join('');
            io.emit('new-message', { platform: 'youtube', user: item.author.name, color: '#ff0000', badges: {}, text: txt });
        });

        ytChat.on("error", (err) => {
            console.error(`❌ YT Library Error: ${err.message}`);
            io.emit('status-update', { platform: 'youtube', connected: false });
        });
        
        ytChat.start()
            .then(() => {
                console.log("✅ YouTube Connected!");
                io.emit('status-update', { platform: 'youtube', connected: true });
            })
            .catch((err) => {
                console.error(`❌ YT Start Failed: ${err.message}`);
                io.emit('status-update', { platform: 'youtube', connected: false });
            });
    } catch (e) { 
        console.error("❌ YT Setup Error:", e.message);
        io.emit('status-update', { platform: 'youtube', connected: false }); 
    }
}

function connectTwitch(channel) {
    if (tmiClient) try { tmiClient.disconnect(); } catch(e) {}
    tmiClient = new tmi.Client({ connection: { reconnect: true, secure: true }, channels: [channel] });
    tmiClient.on('message', (chan, tags, msg, self) => {
        if (!self) io.emit('new-message', { platform: 'twitch', user: tags['display-name'], color: tags.color || '#9147ff', badges: tags.badges || {}, emotes: tags.emotes, text: msg });
    });
    tmiClient.connect().then(() => {
        console.log("✅ Twitch Connected!");
        io.emit('status-update', { platform: 'twitch', connected: true });
    });
    loadAssets(channel);
}

async function loadAssets(channel) {
    try {
        const g = await (await fetch('https://badges.twitch.tv/v1/badges/global/display')).json();
        const cRes = await fetch(`https://badges.twitch.tv/v1/badges/channels/${channel}/display`).catch(() => null);
        badgeMap = { ...g.badge_sets, ...(cRes?.ok ? (await cRes.json()).badge_sets : {}) };
        emoteMap = {};
        const s = await fetch(`https://7tv.io/v3/users/twitch/${channel}`).catch(() => null);
        if (s?.ok) (await s.json()).emote_set?.emotes.forEach(e => { emoteMap[e.name] = `https://cdn.7tv.app/emote/${e.id}/3x.webp`; });
        io.emit('init-assets', { emotes: emoteMap, badges: badgeMap });
    } catch (e) {}
}

loadConfig();
connectTwitch(TWITCH_CHANNEL);
connectYouTube(YOUTUBE_ID);

io.on('connection', (socket) => {
    socket.emit('init-assets', { emotes: emoteMap, badges: badgeMap });
    socket.emit('current-config', { twitch: TWITCH_CHANNEL, youtube: YOUTUBE_DISPLAY_NAME, buildDate: BUILD_DATE });
    socket.emit('status-update', { platform: 'twitch', connected: tmiClient?.readyState() === 'OPEN' });
    socket.emit('status-update', { platform: 'youtube', connected: !!ytChat });

    socket.on('feature-msg', (d) => io.emit('show-feature', d));
    socket.on('clear-msg', () => io.emit('clear-overlay'));
    socket.on('update-channels', async (d) => {
        TWITCH_CHANNEL = d.twitch.toLowerCase().trim();
        const yt = await getYoutubeId(d.youtube);
        if (yt) { 
            YOUTUBE_ID = yt.id; 
            YOUTUBE_DISPLAY_NAME = yt.name; 
            socket.emit('name-update', { youtube: yt.name }); 
        } else { 
            YOUTUBE_DISPLAY_NAME = d.youtube.trim(); 
        }
        saveConfig(); connectTwitch(TWITCH_CHANNEL); connectYouTube(YOUTUBE_ID);
    });
});

app.get('/', (r, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/overlay', (r, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
server.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));