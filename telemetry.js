'use strict';
/*  Live Assetto Corsa telemetry.

    Two sources per server, merged into one snapshot:
      1. The AC server's UDP plugin protocol (ACSP). The server pushes session, car and lap events to us in
         real time. This is what gives us the track, layout, cars on track and lap times.
      2. The AC server's HTTP /INFO endpoint, polled every few seconds, for online status and player counts.

    Works with the stock acServer, AssettoServer and stracker (see the README for how to chain stracker). */

const dgram = require('dgram');
const axios = require('axios');

/* ACSP packet ids: server -> plugin */
const P = { NEW_SESSION: 50, NEW_CONNECTION: 51, CONNECTION_CLOSED: 52, CAR_INFO: 54, SESSION_INFO: 59, LAP_COMPLETED: 73 };
/* plugin -> server */
const REQ = { GET_CAR_INFO: 201, GET_SESSION_INFO: 204 };

const SESSION_TYPES = { 0: 'Booking', 1: 'Practice', 2: 'Qualifying', 3: 'Race' };
const MAX_BOARD = 200;

/* ---------- binary reader ---------- */
class Reader {
    constructor(buf) { this.b = buf; this.o = 0; }
    u8()  { const v = this.b.readUInt8(this.o);    this.o += 1; return v; }
    u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
    i32() { const v = this.b.readInt32LE(this.o);  this.o += 4; return v; }
    u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    f32() { const v = this.b.readFloatLE(this.o);  this.o += 4; return v; }
    /* UTF-8 string: 1 length byte (bytes) + data */
    str() { const n = this.u8(); const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
    /* "wide" string: 1 length byte (characters) + UTF-32LE data */
    wstr() {
        const n = this.u8(); let s = '';
        for (let i = 0; i < n; i++) {
            const cp = this.b.readUInt32LE(this.o); this.o += 4;
            s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
        }
        return s;
    }
}

const prettify = s => String(s || '').split(/[\\/]/).pop().replace(/^(ks_|csp_)/i, '').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

class LiveServer {
    constructor(cfg, names = {}) {
        this.cfg = cfg;
        this.names = names;
        this.cars = new Map();       // carId -> { carId, driver, guid, model, skin, laps, lastLap, bestLap }
        this.boards = new Map();     // "track|layout" -> Map(guid -> { guid, driver, model, timeMs, at })
        this.session = null;
        this.info = { ok: false, clients: null, max: null };
        this.sock = null;
    }

    /* ---------- lifecycle ---------- */
    start() {
        const { id, pluginListenPort } = this.cfg;
        this.sock = dgram.createSocket('udp4');
        this.sock.on('error', e => console.error(`[live:${id}] UDP error:`, e.message));
        this.sock.on('message', msg => this.handle(msg));
        this.sock.bind(pluginListenPort, () => console.log(`[live:${id}] listening for AC plugin packets on UDP ${pluginListenPort}`));
        this.sync();
        this.pollInfo();
        this.timer = setInterval(() => this.pollInfo(), 5000);
    }

    stop() { clearInterval(this.timer); try { this.sock.close(); } catch (e) { /* already closed */ } }

    send(buf) { this.sock.send(buf, this.cfg.pluginServerPort, this.cfg.acHost, () => {}); }

    /* Ask the server to describe itself, so we're correct even if we started mid-session. */
    sync() {
        const s = Buffer.alloc(3); s.writeUInt8(REQ.GET_SESSION_INFO, 0); s.writeInt16LE(-1, 1); this.send(s);
        for (let i = 0; i < (this.cfg.maxClients || 32); i++) {
            const c = Buffer.alloc(3); c.writeUInt8(REQ.GET_CAR_INFO, 0); c.writeUInt16LE(i, 1); this.send(c);
        }
    }

    async pollInfo() {
        const { acHost, httpPort } = this.cfg;
        try {
            const { data } = await axios.get(`http://${acHost}:${httpPort}/INFO`, { timeout: 2500 });
            this.info = { ok: true, clients: Number(data.clients), max: Number(data.maxclients) };
            /* Our car list drifted from the server's player count (e.g. we restarted): resync. */
            if (Number.isFinite(this.info.clients) && this.info.clients !== this.cars.size) this.sync();
        } catch (e) {
            this.info = { ok: false, clients: null, max: null };
            this.cars.clear();
        }
    }

    /* ---------- packet handling ---------- */
    handle(msg) {
        try {
            const r = new Reader(msg);
            switch (r.u8()) {
                case P.NEW_SESSION:
                case P.SESSION_INFO:      return this.onSession(r);
                case P.NEW_CONNECTION:    return this.onConnect(r);
                case P.CONNECTION_CLOSED: return this.onClose(r);
                case P.CAR_INFO:          return this.onCarInfo(r);
                case P.LAP_COMPLETED:     return this.onLap(r);
                default: return;
            }
        } catch (e) {
            console.warn(`[live:${this.cfg.id}] could not parse packet:`, e.message);
        }
    }

    onSession(r) {
        r.u8(); r.u8(); r.u8(); r.u8();                     // protocol version, session index, current index, count
        const serverName = r.wstr(), track = r.str(), layout = r.str(), name = r.str();
        const type = r.u8(); r.u16(); r.u16(); r.u16();     // type, minutes, laps, wait time
        const air = r.u8(), road = r.u8(), graphics = r.str();
        this.session = { serverName, track, layout, name, type, air, road, graphics };
        /* New session: per-session lap counters restart. */
        this.cars.forEach(c => { c.laps = 0; c.lastLap = null; c.bestLap = null; });
    }

    addCar(carId, driver, guid, model, skin) {
        const prev = this.cars.get(carId);
        const same = prev && prev.guid === guid;
        this.cars.set(carId, { carId, driver, guid, model, skin,
            laps: same ? prev.laps : 0, lastLap: same ? prev.lastLap : null, bestLap: same ? prev.bestLap : null });
    }

    onConnect(r) {
        const driver = r.wstr(), guid = r.wstr(), carId = r.u8(), model = r.str(), skin = r.str();
        this.addCar(carId, driver, guid, model, skin);
    }

    onClose(r) {
        r.wstr(); r.wstr();
        this.cars.delete(r.u8());
    }

    onCarInfo(r) {
        const carId = r.u8(), connected = r.u8();
        const model = r.wstr(), skin = r.wstr(), driver = r.wstr(), guid = r.wstr();
        if (connected) this.addCar(carId, driver, guid, model, skin); else this.cars.delete(carId);
    }

    onLap(r) {
        const carId = r.u8(), lapMs = r.u32(), cuts = r.u8();
        const car = this.cars.get(carId);
        if (!car) return;
        car.laps += 1; car.lastLap = lapMs;
        if (cuts !== 0 || lapMs <= 0 || lapMs > 3600000) return;       // only clean laps count
        if (car.bestLap === null || lapMs < car.bestLap) car.bestLap = lapMs;

        const key = this.boardKey();
        if (!this.boards.has(key)) this.boards.set(key, new Map());
        const board = this.boards.get(key), cur = board.get(car.guid);
        if (!cur || lapMs < cur.timeMs) board.set(car.guid, { guid: car.guid, driver: car.driver, model: car.model, timeMs: lapMs, at: Date.now() });
        if (board.size > MAX_BOARD) {
            const worst = [...board.values()].sort((a, b) => b.timeMs - a.timeMs)[0];
            board.delete(worst.guid);
        }
    }

    boardKey() { const s = this.session; return s ? `${s.track}|${s.layout}` : 'unknown'; }

    /* ---------- output ---------- */
    carName(model)  { return this.names.cars?.[String(model).toLowerCase()] || prettify(model); }
    trackName(track) { return this.names.tracks?.[String(track).toLowerCase()] || prettify(track); }

    snapshot() {
        const { id, type, name, desc, publicIp, httpPort, maxClients } = this.cfg;
        const s = this.session, online = this.info.ok;
        const trackName = s ? this.trackName(s.track) : null;
        const layout = s && s.layout ? prettify(s.layout) : '';

        const cars = online ? [...this.cars.values()].map(c => ({
            carId: c.carId, driver: c.driver, guid: c.guid, car: this.carName(c.model), skin: c.skin,
            laps: c.laps, lastLap: c.lastLap === null ? null : c.lastLap / 1000, bestLap: c.bestLap === null ? null : c.bestLap / 1000,
        })) : [];

        const rows = [...(this.boards.get(this.boardKey())?.values() || [])].sort((a, b) => a.timeMs - b.timeMs).slice(0, 50);
        const leaderboard = rows.map((e, i) => ({
            pos: i + 1, guid: e.guid, driver: e.driver, car: this.carName(e.model),
            time: e.timeMs / 1000, gap: i ? (e.timeMs - rows[0].timeMs) / 1000 : 0, at: e.at,
        }));

        return {
            id, type, name, desc, publicIp, httpPort, online,
            players: online ? (Number.isFinite(this.info.clients) ? this.info.clients : cars.length) : 0,
            maxPlayers: Number.isFinite(this.info.max) ? this.info.max : maxClients || 0,
            track: s ? { id: s.track, name: trackName, layout, label: layout ? `${trackName} (${layout})` : trackName } : null,
            session: s ? { name: s.name, type: SESSION_TYPES[s.type] || 'Session' } : null,
            weather: s ? { air: s.air, road: s.road, graphics: s.graphics } : null,
            cars, leaderboard,
        };
    }
}

function startTelemetry(config) {
    const live = new Map();
    for (const cfg of config.servers) {
        const srv = new LiveServer(cfg, config.names);
        srv.start();
        live.set(cfg.id, srv);
    }
    return live;
}

module.exports = { startTelemetry, LiveServer, Reader };
