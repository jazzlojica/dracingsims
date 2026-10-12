/* DRS data layer.
   Live data (drivers, servers, lap times, login) comes from the Node backend (server.js).
   Events, schedule, products and the tier tables below are static site content you edit by hand. */

const DRS = {
    API_BASE: '',                       // '' when Express serves this site; else the backend's full URL
    CONTACT_EMAIL: 'you@example.com',   // <- product inquiries are sent here
    CURRENCY: '$',                      // change to your currency symbol
    TOUGE_TIERS: [
        { name: 'D-Class', sub: 'Novice · Green Leaves', min: 1,    max: 399,  color: '#4ade80', desc: 'Stock Miata or BRZ, still learning the lines.' },
        { name: 'C-Class', sub: 'Street Tuner',          min: 400,  max: 799,  color: '#38bdf8', desc: 'Consistent times on your home course.' },
        { name: 'B-Class', sub: 'Pass Regular',          min: 800,  max: 1199, color: '#facc15', desc: 'Versatile across multiple passes and weather.' },
        { name: 'A-Class', sub: 'Touge Master',          min: 1200, max: 1699, color: '#fb923c', desc: 'Advanced technique, record holders.' },
        { name: 'S-Class', sub: 'The Ghosts · Legends',  min: 1700, max: 2000, color: '#c084fc', desc: 'Undefeated peak drivers.' },
    ],
    GT3_TIERS: [
        { name: 'Bronze',   min: 0,    max: 499,    color: '#CD7F32', desc: 'Amateurs and new entries.' },
        { name: 'Silver',   min: 500,  max: 1199,   color: '#C0C0C0', desc: 'Consistent, competitive drivers.' },
        { name: 'Gold',     min: 1200, max: 1999,   color: '#FFD700', desc: 'Advanced drivers and podium contenders.' },
        { name: 'Platinum', min: 2000, max: 99999,  color: '#00F0FF', desc: 'Elite community drivers.' },
    ],
    GT3_POINTS: [['1st place', 100], ['2nd place', 80], ['3rd place', 65], ['4th–5th', 50], ['6th–10th', 30],
                 ['11th–15th', 15], ['16th+ / DNF', 5], ['Pole position', 10], ['Fastest lap', 10], ['Safety infraction', -15]],
};

/* Battle points: win = true/false, gap = opponent tier index minus yours. */
DRS.delta = (win, gap) => win ? (gap > 0 ? Math.min(50, 30 + 5 * gap) : 25)
                              : (gap < 0 ? -Math.min(40, 20 + 5 * -gap) : -15);

DRS.events = [
    { title: 'Round-Robin Touge Cup · Round 1', course: 'Akina', date: '2026-10-24T12:00:00Z', classes: ['C-Class', 'B-Class'], reg: '#',
      rules: ['Every driver battles every other driver once, lead then chase.', 'Win = 3 pts, draw = 1 pt, loss = 0 pts.', 'Contact that causes a spin means an automatic loss for the driver at fault.', 'Stock-tuned cars from the approved list only.'] },
    { title: 'Round-Robin Touge Cup · Round 2', course: 'Shomaru Pass', date: '2026-10-31T12:00:00Z', classes: ['A-Class', 'S-Class'], reg: '#',
      rules: ['Same format as Round 1. Top 4 overall go to the finals.', 'No-show forfeits the battle.', 'Race director decisions are final.'] },
    { title: 'Gunsai Night Run (Open)', course: 'Gunsai Touge', date: '2026-11-07T13:30:00Z', classes: ['All classes'], reg: '#',
      rules: ['Casual open lobby with ranked battle points enabled.', 'Be respectful: yield to cars on a flying lap.'] },
];

DRS.schedule = [
    { title: 'Sprint Series · Week 1',  tier: 'Open',    track: 'Spa-Francorchamps', date: '2026-10-18T13:00:00Z', weather: '17°C · Dry',        format: 'Quali 10 min · Race 25 min', req: ['Min safety rating 1.50', 'Fixed setup'] },
    { title: 'Sprint Series · Gold+',   tier: 'Gold',    track: 'Monza',             date: '2026-10-20T13:00:00Z', weather: '21°C · Dry',        format: 'Quali 10 min · Race 30 min', req: ['Gold tier or above', 'Min safety rating 3.00'] },
    { title: 'Sprint Series · Bronze',  tier: 'Bronze',  track: 'Imola',             date: '2026-10-22T13:00:00Z', weather: '15°C · Light rain', format: 'Quali 10 min · Race 20 min', req: ['Bronze tier only', 'Tyre wear 1×'] },
    { title: 'Endurance · 2 Hours',     tier: 'Silver',  track: 'Nürburgring GP',    date: '2026-10-25T12:00:00Z', weather: '19°C · Dynamic',    format: 'Quali 15 min · Race 120 min', req: ['Silver tier or above', 'Mandatory pit stop', 'Min safety rating 2.00'] },
];

DRS.products = [
    { id: 'livery', name: 'DRS Team Livery Pack', type: 'Digital', price: 9, desc: 'Six DRS-branded skins for popular touge cars.', details: ['Works with CSP', 'Includes 6 skins', 'Free updates'] },
    { id: 'custom', name: 'Custom Livery', type: 'Commission', price: 35, desc: 'A one-off skin built around your car and your design.', details: ['1 car of your choice', '2 revisions', '3–5 days turnaround'] },
    { id: 'setups', name: 'Touge Setup Pack', type: 'Digital', price: 12, desc: 'Tested setups for the most popular cars on EK touge tracks.', details: ['12 cars', 'Dry and wet variants', 'Drift and grip versions'] },
    { id: 'tee', name: 'DRS Team Tee', type: 'Merch', price: 22, desc: 'Black cotton tee with the DRS logo on the chest.', details: ['Sizes S–XXL', 'Made to order'] },
    { id: 'stickers', name: 'Sticker Set', type: 'Merch', price: 6, desc: 'Vinyl sticker set for the car, laptop or wheel rig.', details: ['6 stickers', 'Weatherproof'] },
    { id: 'coach', name: '1-on-1 Coaching', type: 'Service', price: 25, desc: 'An hour of voice coaching on a course of your choice.', details: ['60 minutes', 'Telemetry review included'] },
];

/* ---------- API (talks to server.js) ---------- */
const http = async (path, opts = {}) => {
    const r = await fetch(DRS.API_BASE + path, { credentials: 'include', cache: 'no-store', ...opts });
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
};
const P = v => Promise.resolve(v);
DRS.api = {
    me:       () => http('/api/me'),
    logout:   () => http('/auth/logout', { method: 'POST' }),
    drivers:  () => http('/api/drivers').then(d => d.drivers),                               // signed-in drivers only
    live:     type => http('/api/server-live' + (type ? '?type=' + type : '')).then(d => d.servers),
    events:   () => P(DRS.events),
    schedule: () => P(DRS.schedule),
    products: () => P(DRS.products),
};
