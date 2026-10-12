'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const admin = require('firebase-admin');

const { startTelemetry } = require('./lib/telemetry');
const serversConfig = require('./servers.config');

/* ---------- config ---------- */
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || '').replace(/\/$/, '');   // empty = same origin
const HOME = CLIENT_ORIGIN || '';                                              // where to send users after login/logout
const IS_PROD = process.env.NODE_ENV === 'production';
const STALE_MS = (Number(process.env.DRIVER_STALE_MINUTES) || 30) * 60 * 1000;
const CROSS_SITE = Boolean(CLIENT_ORIGIN) && CLIENT_ORIGIN !== BASE_URL;

for (const k of ['STEAM_API_KEY', 'SESSION_SECRET']) {
    if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

/* ---------- Firebase Admin ---------- */
const saPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json');
if (!fs.existsSync(saPath)) { console.error(`Firebase service account file not found: ${saPath}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(saPath, 'utf8'))) });
const db = admin.firestore();
const drivers = db.collection('drivers');
const { FieldValue, Timestamp } = admin.firestore;

/* Save/refresh the profile and mark the driver as signed in. Stats fields (rating, wins, ...) are never touched. */
async function markSignedIn(u) {
    const ref = drivers.doc(u.steamId);
    const snap = await ref.get();
    const data = { steamId: u.steamId, name: u.name, avatar: u.avatar, profileUrl: u.profileUrl,
                   signedIn: true, lastLogin: FieldValue.serverTimestamp(), lastSeen: FieldValue.serverTimestamp() };
    if (!snap.exists) data.createdAt = FieldValue.serverTimestamp();
    await ref.set(data, { merge: true });
    driversCache.at = 0;
}

async function markSignedOut(steamId) {
    await drivers.doc(steamId).set({ signedIn: false, lastLogout: FieldValue.serverTimestamp() }, { merge: true });
    driversCache.at = 0;
}

/* ---------- Passport / Steam ---------- */
passport.serializeUser((user, done) => done(null, user));          // the session holds this small object
passport.deserializeUser((user, done) => done(null, user));

passport.use(new SteamStrategy(
    { returnURL: `${BASE_URL}/auth/steam/return`, realm: `${BASE_URL}/`, apiKey: process.env.STEAM_API_KEY },
    async (identifier, profile, done) => {
        try {
            const j = profile._json || {};
            const user = {
                steamId: String(j.steamid || profile.id),                                   // SteamID64
                name: j.personaname || profile.displayName || 'Unknown driver',
                avatar: j.avatarfull || (profile.photos && profile.photos[2] && profile.photos[2].value) || '',
                profileUrl: j.profileurl || `https://steamcommunity.com/profiles/${profile.id}`,
            };
            await markSignedIn(user);
            done(null, user);
        } catch (e) { done(e); }
    }
));

/* ---------- app ---------- */
const app = express();
if (IS_PROD) app.set('trust proxy', 1);                // needed for secure cookies behind nginx / Cloudflare / a host's proxy

if (CLIENT_ORIGIN) app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));

app.use(session({
    name: 'drs.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: IS_PROD, sameSite: CROSS_SITE ? 'none' : 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());

/* ---------- auth routes ---------- */
app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: `${HOME}/#/home` }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: `${HOME}/#/home` }),
    (req, res) => res.redirect(`${HOME}/#/home`));

app.post('/auth/logout', async (req, res, next) => {
    const u = req.user;
    try { if (u) await markSignedOut(u.steamId); } catch (e) { console.error('logout: firestore update failed:', e.message); }
    req.logout(err => {
        if (err) return next(err);
        req.session.destroy(() => { res.clearCookie('drs.sid'); res.json({ ok: true }); });
    });
});

/* Current user. The frontend also calls this every couple of minutes as a heartbeat. */
app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ authenticated: false });
    if (Date.now() - (req.session.lastBeat || 0) > 60 * 1000) {
        req.session.lastBeat = Date.now();
        drivers.doc(req.user.steamId).set({ signedIn: true, lastSeen: FieldValue.serverTimestamp() }, { merge: true })
            .then(() => { driversCache.at = 0; })
            .catch(e => console.error('heartbeat failed:', e.message));
    }
    res.json({ authenticated: true, user: req.user });
});

/* ---------- drivers (signed in only) ---------- */
const STAT_FIELDS = ['rating', 'battles', 'wins', 'records', 'gt3', 'gt3Wins', 'podiums', 'sr'];
const driversCache = { at: 0, data: null };

app.get('/api/drivers', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (driversCache.data && Date.now() - driversCache.at < 10000) return res.json(driversCache.data);
    try {
        const snap = await drivers.where('signedIn', '==', true).get();
        const cutoff = Date.now() - STALE_MS;
        const out = [], batch = db.batch();
        let stale = 0;
        snap.forEach(doc => {
            const d = doc.data();
            const seen = d.lastSeen instanceof Timestamp ? d.lastSeen.toMillis() : 0;
            if (seen < cutoff) { batch.update(doc.ref, { signedIn: false }); stale++; return; }   // closed the tab without logging out
            const pub = { steamId: doc.id, name: d.name, avatar: d.avatar, profileUrl: d.profileUrl };
            for (const k of STAT_FIELDS) if (d[k] !== undefined) pub[k] = d[k];
            out.push(pub);
        });
        if (stale) await batch.commit();
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        driversCache.data = { drivers: out }; driversCache.at = Date.now();
        res.json(driversCache.data);
    } catch (e) {
        console.error('/api/drivers failed:', e.message);
        res.status(500).json({ error: 'Could not load drivers' });
    }
});

/* ---------- live server telemetry ---------- */
const live = startTelemetry(serversConfig);

app.get('/api/server-live', (req, res) => {
    let list = [...live.values()].map(s => s.snapshot());
    if (req.query.type) list = list.filter(s => s.type === req.query.type);
    if (req.query.id) list = list.filter(s => s.id === req.query.id);
    res.set('Cache-Control', 'no-store');
    res.json({ servers: list, updatedAt: Date.now() });
});

/* ---------- static site ---------- */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`DRS site running at ${BASE_URL} (port ${PORT})`));

process.on('SIGINT', () => { live.forEach(s => s.stop()); process.exit(0); });
