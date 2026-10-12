(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(3).padStart(6, '0'); };
const sgn = d => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(3);
const ago = h => h < 1 ? 'just now' : h < 48 ? Math.round(h) + 'h ago' : Math.round(h / 24) + 'd ago';
const when = iso => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const tierOf = (tiers, p) => tiers.find(t => p <= t.max) || tiers[tiers.length - 1];
const badge = t => `<span class="badge" style="--c:${t.color}">${esc(t.name)}</span>`;
const range = t => t.max >= 9999 ? t.min + '+' : t.min + '–' + t.max;
const AUTH = { user: null };
const ME = () => (AUTH.user ? AUTH.user.steamId : null);
const S = { live: { touge: null, gt3: null } };
const safeUrl = u => (/^https:\/\//.test(u || '') ? u : '#');
const agoMs = t => ago((Date.now() - t) / 3600000);

/* A poller belongs to the page that started it; navigating away (RT changes) stops it. */
let RT = 0;
const poll = (fn, ms) => { const my = RT, id = setInterval(() => (my !== RT ? clearInterval(id) : fn()), ms); };

/* ---------- login widget ---------- */
function renderAuth() {
    const u = AUTH.user, el = $('#auth');
    el.innerHTML = u
        ? `<a class="me-chip" href="${esc(safeUrl(u.profileUrl))}" target="_blank" rel="noopener" title="Your Steam profile"><img class="avatar" src="${esc(u.avatar)}" alt=""><span>${esc(u.name)}</span></a><button class="btn" id="logout">Log out</button>`
        : `<a class="btn red" href="${esc(DRS.API_BASE)}/auth/steam">Sign in with Steam</a>`;
    const b = $('#logout');
    if (b) b.onclick = async () => { try { await DRS.api.logout(); } catch (e) {} AUTH.user = null; renderAuth(); route(); };
}
async function loadAuth() {
    try { const r = await DRS.api.me(); AUTH.user = r.authenticated ? r.user : null; } catch (e) { /* backend unreachable: stay signed out */ }
    renderAuth();
}

/* ---------- shared pieces ---------- */
const serverCard = s => {
    const w = s.weather ? `${s.weather.air}°C${s.session ? ' · ' + esc(s.session.type) : ''}` : '';
    return `
<article class="card server">
  <div class="cover"><span class="status ${s.online ? 'on' : 'off'}">${s.online ? 'Online' : 'Offline'}</span>${w ? `<span class="chip">${w}</span>` : ''}</div>
  <div class="body">
    <p class="muted sm">${esc(s.desc || '')}</p><h3>${esc(s.name)}</h3><p class="muted sm">${s.online && s.track ? esc(s.track.label) : '—'}</p>
    <div class="players"><strong>${s.players}</strong><span>/ ${s.maxPlayers} drivers</span></div>
    <div class="bar"><i style="width:${s.maxPlayers ? Math.round(s.players / s.maxPlayers * 100) : 0}%"></i></div>
    <div class="row">${s.online ? `<a class="btn red" href="acmanager://race/online/join?ip=${encodeURIComponent(s.publicIp)}&amp;httpPort=${s.httpPort}">Connect</a>` : '<span class="btn off">Connect</span>'}
    <button class="btn" data-copy="${esc(s.publicIp)}:${s.httpPort}">Copy IP</button></div>
  </div>
</article>`;
};

/* Signed-in drivers. Stat fields are optional: they only show when the driver's Firestore doc has them. */
const driverCard = (d, mode) => {
    const tier = mode === 'touge' && d.rating != null ? tierOf(DRS.TOUGE_TIERS, d.rating)
               : mode === 'gt3' && d.gt3 != null ? tierOf(DRS.GT3_TIERS, d.gt3) : null;
    const st = mode === 'touge' && d.rating != null ? [[d.rating, 'Points'], [d.battles ?? 0, 'Battles'], [d.wins ?? 0, 'Wins'], [d.records ?? 0, 'Records']]
             : mode === 'gt3' && d.gt3 != null ? [[d.gt3, 'Points'], [d.gt3Wins ?? 0, 'Wins'], [d.podiums ?? 0, 'Podiums'], [d.sr ?? '—', 'Safety']] : null;
    return `
<a class="card driver ${d.steamId === ME() ? 'me' : ''}" href="${esc(safeUrl(d.profileUrl))}" target="_blank" rel="noopener">
  <img class="avatar lg" src="${esc(d.avatar)}" alt="">
  <div><strong>${esc(d.name)}</strong>${tier ? badge(tier) : '<span class="muted sm">Online now</span>'}</div>
  ${st ? `<div class="stats">${st.map(([v, l]) => `<div><b>${esc(v)}</b><span>${l}</span></div>`).join('')}</div>` : ''}
</a>`;
};
const driverGrid = (ds, mode) => `<div class="grid drivers" id="driverGrid">${ds.length ? ds.map(d => driverCard(d, mode)).join('') : '<p class="muted">No drivers are signed in right now.</p>'}</div>`;

const tierCards = tiers => `<div class="grid tiers">${tiers.map(t => `
<div class="card tier" style="--c:${t.color}"><div class="top">${badge(t)}<b>${range(t)} pts</b></div>
${t.sub ? `<strong>${esc(t.sub)}</strong>` : ''}<p class="muted">${esc(t.desc)}</p></div>`).join('')}</div>`;

const table = (head, rows) => `<div class="tbl-wrap"><table><thead><tr>${head.map(h => `<th${h[0] === '>' ? ' class="r"' : ''}>${esc(h.replace(/^>/, ''))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;

/* ---------- live server panel (map, cars on track, live lap times) ---------- */
const liveCard = (s, rows) => {
    if (!s.online) return `<div class="card live-off"><p class="muted">${esc(s.name)} is offline right now.</p></div>`;
    const t = s.track;
    const info = [[t ? t.name : '—', 'Map'], [t && t.layout ? t.layout : '—', 'Layout'], [s.session ? s.session.type : '—', 'Session'], [`${s.players}/${s.maxPlayers}`, 'Drivers']];
    const cars = s.cars.length
        ? table(['Driver', 'Car', '>Laps', '>Last lap', '>Best lap'], s.cars.map(c => `
<tr class="${c.guid === ME() ? 'me' : ''}"><td>${esc(c.driver)}${c.guid === ME() ? ' <em class="you">you</em>' : ''}</td><td>${esc(c.car)}</td><td class="r">${c.laps}</td>
<td class="r">${c.lastLap == null ? '—' : fmt(c.lastLap)}</td><td class="r t">${c.bestLap == null ? '—' : fmt(c.bestLap)}</td></tr>`).join(''))
        : '<p class="muted">Nobody is on track right now.</p>';
    const laps = s.leaderboard.length
        ? table(['#', 'Driver', 'Car', '>Best lap', '>Gap', 'Set'], s.leaderboard.slice(0, rows).map(r => `
<tr class="${r.guid === ME() ? 'me' : ''}"><td>${r.pos}</td><td>${esc(r.driver)}${r.guid === ME() ? ' <em class="you">you</em>' : ''}</td><td>${esc(r.car)}</td>
<td class="r t">${fmt(r.time)}</td><td class="r muted">${r.pos > 1 ? sgn(r.gap) : '—'}</td><td class="muted">${agoMs(r.at)}</td></tr>`).join(''))
        : '<p class="muted">No clean laps recorded on this map yet.</p>';
    return `
<div class="card live-info"><div class="stats">${info.map(([v, l]) => `<div><b>${esc(v)}</b><span>${l}</span></div>`).join('')}</div></div>
<h2 class="h">Cars on track</h2>${cars}
<h2 class="h">Live lap times${t ? ' · ' + esc(t.label) : ''}</h2>${laps}`;
};

/* Fetches /api/server-live, draws it, and refreshes every 5 s until the user leaves the page. */
async function liveView(el, type, { cards, rows }) {
    const draw = async () => {
        let sv;
        try { sv = await DRS.api.live(type); } catch (e) { el.innerHTML = '<p class="muted">Live server data is unavailable right now.</p>'; return; }
        if (!sv.length) { el.innerHTML = '<p class="muted">No servers configured.</p>'; return; }
        const cur = sv.find(s => s.id === S.live[type]) || sv.find(s => s.online) || sv[0];
        S.live[type] = cur.id;
        el.innerHTML = `${cards ? `<h2 class="h">Active servers</h2><div class="grid">${sv.map(serverCard).join('')}</div>` : ''}
${sv.length > 1 ? `<div class="seg livetabs"><span class="muted sm">Server</span>${sv.map(s => `<button class="${s.id === cur.id ? 'on' : ''}" data-sv="${esc(s.id)}">${esc(s.name)}${s.online ? ` · ${s.players}` : ' · off'}</button>`).join('')}</div>` : ''}
${liveCard(cur, rows)}`;
        el.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { S.live[type] = b.dataset.sv; draw(); });
    };
    await draw();
    poll(draw, 5000);
}

/* ---------- Home ---------- */
async function vHome(el) {
    el.outerHTML = `
<section class="hero"><div class="container">
  <img src="assets/img/logo.png" alt="DRS" class="hero-logo">
  <h1>D. <span class="red">Racing</span> Sims</h1>
  <p>Touge battles, GT3 ranked racing and time attacks for Assetto Corsa. Pick a server and hit the road.</p>
  <div class="hero-actions"><a href="#/touge" class="btn red">Touge</a><a href="#/gt3" class="btn">GT3</a></div>
</div></section>
<section class="container view"><div class="grid three">
  <a class="card tile" href="#/touge/overview"><h3>Touge</h3><p class="muted">1v1 battles, rating points and the fastest lap on every pass.</p><span class="live" id="st-touge">…</span></a>
  <a class="card tile" href="#/gt3/overview"><h3>GT3</h3><p class="muted">Weekly ranked sprint and endurance races with tier-matched lobbies.</p><span class="live" id="st-gt3">…</span></a>
  <a class="card tile" href="#/products"><h3>Products</h3><p class="muted">Liveries, setups and merch. Message me if something catches your eye.</p><span class="live">Browse the shop →</span></a>
</div>
<h2 class="h">Drivers online</h2><div id="homeDrivers"></div></section>`;
    const refresh = async () => {
        const [sv, ds] = await Promise.all([DRS.api.live().catch(() => null), DRS.api.drivers().catch(() => null)]);
        if (sv) for (const t of ['touge', 'gt3']) {
            const a = sv.filter(s => s.type === t), n = $('#st-' + t);
            if (n) n.textContent = `${a.filter(s => s.online).length} servers online · ${a.reduce((n, s) => n + s.players, 0)} drivers racing`;
        }
        const g = $('#homeDrivers'); if (g && ds) g.innerHTML = driverGrid(ds);
    };
    await refresh();
    poll(refresh, 15000);
}

/* ---------- Touge ---------- */
const vTougeOverview = el => liveView(el, 'touge', { cards: true, rows: 10 });
const vTougeLb       = el => liveView(el, 'touge', { cards: false, rows: 50 });

async function vTougeRankings(el) {
    const ds = (await DRS.api.drivers()).filter(d => d.rating != null).sort((a, b) => b.rating - a.rating);
    const gaps = [4, 3, 2, 1, 0, -1, -2, -3, -4];
    el.innerHTML = `
<h2 class="h">Highest ranked <span class="muted sm">(drivers signed in now)</span></h2>
${ds.length ? table(['#', 'Driver', 'Class', '>Points', '>Battles'], ds.map((d, i) => `<tr class="${d.steamId === ME() ? 'me' : ''}"><td>${i + 1}</td><td>${esc(d.name)}</td><td>${badge(tierOf(DRS.TOUGE_TIERS, d.rating))}</td><td class="r t">${d.rating}</td><td class="r muted">${d.battles ?? 0}</td></tr>`).join('')) : '<p class="muted">No ranked drivers are signed in right now.</p>'}
<h2 class="h">Classes</h2>${tierCards(DRS.TOUGE_TIERS)}
<h2 class="h">Battle points</h2>
<p class="muted lead">Rating runs from 1 to 2000. Every 1v1 battle moves points by an Elo-style amount: more for upsets, less for expected results.</p>
${table(['Opponent vs your class', '>Win', '>Loss'], gaps.map(g => `<tr><td>${g === 0 ? 'Same class' : Math.abs(g) + (Math.abs(g) > 1 ? ' classes ' : ' class ') + (g > 0 ? 'higher' : 'lower')}</td><td class="r ok">+${DRS.delta(true, g)}</td><td class="r bad">−${-DRS.delta(false, g)}</td></tr>`).join(''))}`;
}

async function vTougeDrivers(el) {
    const draw = async () => {
        let ds; try { ds = await DRS.api.drivers(); } catch (e) { el.innerHTML = '<p class="muted">Could not load drivers right now.</p>'; return; }
        el.innerHTML = `<h2 class="h">Drivers online</h2>${driverGrid(ds, 'touge')}`;
    };
    await draw();
    poll(draw, 30000);
}

async function vTougeNews(el) {
    const ev = await DRS.api.events();
    el.innerHTML = `<h2 class="h">Announcements</h2><div class="grid">${ev.map(e => `
<article class="card event"><div class="body">
  <h3>${esc(e.title)}</h3>
  <dl><dt>Course</dt><dd>${esc(e.course)}</dd><dt>When</dt><dd>${when(e.date)}</dd><dt>Classes</dt><dd>${e.classes.map(esc).join(', ')}</dd></dl>
  <details><summary>Race rules</summary><ul>${e.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></details>
  <a class="btn red" href="${esc(e.reg)}" target="_blank" rel="noopener">Register</a>
</div></article>`).join('')}</div>`;
}

/* ---------- GT3 ---------- */
async function vGtOverview(el) {
    el.innerHTML = `<div id="lv"></div>
<h2 class="h">Tiers</h2>${tierCards(DRS.GT3_TIERS)}
<h2 class="h">Weekly points</h2>
${table(['Result', '>Points'], DRS.GT3_POINTS.map(([k, v]) => `<tr><td>${k}</td><td class="r ${v < 0 ? 'bad' : 'ok'}">${v > 0 ? '+' : '−'}${Math.abs(v)}</td></tr>`).join(''))}
<h2 class="h">Season rules</h2>
<ul class="rules">
  <li><b>Tier lobbies.</b> Each week has a Bronze, Silver and Gold+ lobby, so you race people at your pace.</li>
  <li><b>Safety rating gate.</b> Higher lobbies ask for a minimum safety rating, so clean drivers aren't wrecked by the rest.</li>
  <li><b>Promotion.</b> Cross a tier line and you move up from the next event. Seasons run 8 weeks, then points are halved, not wiped.</li>
</ul>`;
    await liveView($('#lv'), 'gt3', { cards: true, rows: 10 });
}

async function vGtStandings(el) {
    const draw = async () => {
        let ds; try { ds = await DRS.api.drivers(); } catch (e) { el.innerHTML = '<p class="muted">Could not load drivers right now.</p>'; return; }
        el.innerHTML = `<h2 class="h">Drivers online</h2>${driverGrid(ds, 'gt3')}<h2 class="h">Tiers</h2>${tierCards(DRS.GT3_TIERS)}`;
    };
    await draw();
    poll(draw, 30000);
}

const vGtLb = el => liveView(el, 'gt3', { cards: false, rows: 50 });

async function vGtSchedule(el) {
    const ev = await DRS.api.schedule();
    const t = n => DRS.GT3_TIERS.find(x => x.name === n) || { name: 'Open', color: '#9aa0ab' };
    el.innerHTML = `<h2 class="h">This week and next</h2><div class="grid">${ev.map(e => `
<article class="card event" style="--c:${t(e.tier).color}"><div class="body"><div class="top">${badge(t(e.tier))}<span class="muted sm">${when(e.date)}</span></div>
<h3>${esc(e.title)}</h3>
<dl><dt>Track</dt><dd>${esc(e.track)}</dd><dt>Weather</dt><dd>${esc(e.weather)}</dd><dt>Format</dt><dd>${esc(e.format)}</dd></dl>
<ul class="req">${e.req.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div></article>`).join('')}</div>`;
}

/* ---------- Products ---------- */
async function vProducts(el) {
    const ps = await DRS.api.products(), price = p => DRS.CURRENCY + p.price;
    el.innerHTML = `<h2 class="h">Products</h2><p class="muted lead">Interested in something? Open it and send me an email, and I'll get back to you.</p>
<div class="grid">${ps.map(p => `<button class="card prod" data-p="${p.id}"><div class="thumb"><span>${esc(p.type)}</span></div><div class="body"><h3>${esc(p.name)}</h3><p class="muted sm">${esc(p.desc)}</p><b>${price(p)}</b></div></button>`).join('')}</div>
<dialog id="dlg"></dialog>`;
    const dlg = $('#dlg');
    el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        const p = ps.find(x => x.id === b.dataset.p);
        const mail = `mailto:${DRS.CONTACT_EMAIL}?subject=${encodeURIComponent('Inquiry: ' + p.name)}&body=${encodeURIComponent(`Hi, I'm interested in "${p.name}" (${price(p)}).\n\nMy name / in-game name:\n`)}`;
        dlg.innerHTML = `<h3>${esc(p.name)}</h3><p class="muted sm">${esc(p.type)}</p><p>${esc(p.desc)}</p><ul class="req">${p.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
<div class="row"><b class="big">${price(p)}</b><a class="btn red" href="${mail}">Email me about this</a><button class="btn" data-copy="${esc(DRS.CONTACT_EMAIL)}">Copy email</button><button class="btn" id="x">Close</button></div>`;
        dlg.showModal(); $('#x').onclick = () => dlg.close();
    });
    dlg.onclick = e => { if (e.target === dlg) dlg.close(); };
}

/* ---------- router ---------- */
const NAV = {
    touge: [['overview', 'Overview'], ['leaderboards', 'Leaderboards'], ['rankings', 'Rankings'], ['drivers', 'Drivers'], ['announcements', 'Announcements']],
    gt3: [['overview', 'Overview'], ['standings', 'Standings & Drivers'], ['leaderboards', 'Leaderboards'], ['schedule', 'Schedule']],
};
const V = {
    home: vHome, products: vProducts,
    'touge/overview': vTougeOverview, 'touge/leaderboards': vTougeLb, 'touge/rankings': vTougeRankings, 'touge/drivers': vTougeDrivers, 'touge/announcements': vTougeNews,
    'gt3/overview': vGtOverview, 'gt3/standings': vGtStandings, 'gt3/leaderboards': vGtLb, 'gt3/schedule': vGtSchedule,
};

async function route() {
    RT++;                                          // stops the previous page's pollers
    let [p = 'home', s] = location.hash.replace(/^#\/?/, '').split('/');
    if (!NAV[p] && !V[p]) p = 'home';
    if (NAV[p] && !NAV[p].some(x => x[0] === s)) s = NAV[p][0][0];
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.p === p));
    const head = NAV[p] ? `<div class="container pagehead"><h1>${p === 'gt3' ? 'GT3' : 'Touge'}</h1><nav class="seg sub">${NAV[p].map(([k, l]) => `<a class="${k === s ? 'on' : ''}" href="#/${p}/${k}">${l}</a>`).join('')}</nav></div>` : '';
    $('#app').innerHTML = head + '<div class="container view" id="v"></div>';
    await V[NAV[p] ? p + '/' + s : p]($('#v'));
}

document.addEventListener('click', e => {
    const c = e.target.closest('[data-copy]');
    if (c) navigator.clipboard.writeText(c.dataset.copy).then(() => { const o = c.textContent; c.textContent = 'Copied!'; setTimeout(() => c.textContent = o, 1200); });
});
$('#yr').textContent = new Date().getFullYear();
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
loadAuth().then(route);
setInterval(() => { if (AUTH.user) loadAuth(); }, 120000);   // heartbeat: keeps you listed as signed in while the tab is open
})();
