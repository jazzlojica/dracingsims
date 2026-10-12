# D. Racing Sims: site + Steam login + Firebase + live Assetto Corsa data

```
server.js              Express backend (Steam login, Firebase, /api/*)
lib/telemetry.js       Live AC data: UDP plugin listener + HTTP /INFO poller
servers.config.js      Your AC servers (ports, names)  <- edit this
.env                   Secrets and URLs                <- copy from .env.example
serviceAccountKey.json Firebase key                    <- you add this, never commit it
public/                The website (index.html, assets/js/app.js, data.js, css)
```

## 1. Install and run
```bash
npm install
cp .env.example .env        # then fill it in (steps 2-3)
npm start                   # http://localhost:3000
```
Node 18+ required. The backend serves `public/`, so open the site through it (not by double-clicking index.html).

## 2. Steam
1. Get a free Web API key at https://steamcommunity.com/dev/apikey and put it in `STEAM_API_KEY`.
2. Set `BASE_URL` to the public address of this backend (`http://localhost:3000` locally, `https://your-domain.com` live).
   Steam sends users back to `BASE_URL/auth/steam/return`, so it must match the address in the browser.
3. Set `SESSION_SECRET` to a long random string:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 3. Firebase (you already have the project)
1. Firebase console > Build > Firestore Database: make sure it is created.
2. Project settings > Service accounts > **Generate new private key**. Save it as `serviceAccountKey.json`
   next to `server.js` (or point `FIREBASE_SERVICE_ACCOUNT` at it).
3. Firestore rules: only the backend touches the data (the Admin SDK ignores rules), so lock out browsers:
   ```
   rules_version = '2';
   service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }
   ```
The `drivers` collection is created on the first login. Document id = SteamID64:
`steamId, name, avatar, profileUrl, signedIn, lastLogin, lastSeen, lastLogout, createdAt`.
Optional stat fields you can add by hand or from another script: `rating, battles, wins, records, gt3, gt3Wins, podiums, sr`.
The site shows them on the Rankings / Drivers / Standings pages when present, and never overwrites them.

**Signed-in tracking.** Login sets `signedIn: true`; Log out sets it false. The open site pings `/api/me` every
2 minutes to refresh `lastSeen`. If someone just closes the tab, `/api/drivers` drops them after
`DRIVER_STALE_MINUTES` (default 30) and resets their flag.

## 4. Plug in the Assetto Corsa servers
Edit `servers.config.js`: one entry per server, each with its **own** pair of plugin ports.

In each server's `server_cfg.ini` (`[SERVER]` section), using that entry's ports:
```ini
HTTP_PORT=8081                      ; must equal httpPort
UDP_PLUGIN_LOCAL_PORT=12000         ; = pluginServerPort  (AC listens here)
UDP_PLUGIN_ADDRESS=127.0.0.1:12001  ; = pluginListenPort  (this backend listens here)
```
Restart the AC server. If AC runs on another machine, use this backend's IP in `UDP_PLUGIN_ADDRESS`, set
`acHost` to the AC machine's IP, and open the UDP ports in both firewalls.

Check it works: open `http://<ac-host>:<httpPort>/INFO` (should return JSON), then `http://localhost:3000/api/server-live`.

**AssettoServer:** it speaks the same UDP plugin protocol; use the same two settings in its `server_cfg.ini`.
**stracker:** only one program can own the AC server's plugin port. Point `UDP_PLUGIN_LOCAL_PORT`/`UDP_PLUGIN_ADDRESS`
at stracker as usual, then have stracker forward to this backend with its proxy settings
(`proxy_plugin_local_port` / `proxy_plugin_port` in stracker's `[STRACKER_CONFIG]`; check your stracker version's docs for exact names).

## 5. API
| Endpoint | What it does |
|---|---|
| `GET /auth/steam` | Starts Steam login |
| `GET /auth/steam/return` | Steam callback: saves the profile, sets `signedIn: true` |
| `POST /auth/logout` | Sets `signedIn: false`, ends the session |
| `GET /api/me` | `{authenticated, user:{steamId,name,avatar,profileUrl}}` (also the heartbeat) |
| `GET /api/drivers` | Signed-in drivers only (cached 10 s) |
| `GET /api/server-live[?type=touge\|gt3][&id=akina]` | Per server: online, players, track + layout, session, cars on track, lap leaderboard |

## 6. Going live
- Use HTTPS and set `NODE_ENV=production` (secure cookies). Behind nginx/Cloudflare this is already handled (`trust proxy`).
- Frontend on a different domain? Set `CLIENT_ORIGIN` in `.env` and `API_BASE` in `public/assets/js/data.js`.
- Keep it running with `pm2 start server.js --name drs`.
- Sessions use Express's in-memory store: restarts log everyone out, and it suits a small site. For more, add a session store.

## Notes
- Lap leaderboard = best **clean** lap (no cuts) per driver per track/layout since the backend started. It lives in
  memory; say if you want it saved to Firestore so it survives restarts.
- Live driver ids are Steam IDs (AC's driver GUID), so "you" highlighting works automatically for Steam players.
- Static content (events, schedule, products, tier tables) is still edited in `public/assets/js/data.js`.
