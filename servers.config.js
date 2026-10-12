/* One entry per Assetto Corsa server you want on the site.

   acHost / httpPort : where the AC server's HTTP port (HTTP_PORT in server_cfg.ini) is reachable FROM THIS BACKEND.
   publicIp          : what players connect to (used for the "Connect" button).
   pluginListenPort  : UDP port THIS backend listens on  -> server_cfg.ini  UDP_PLUGIN_ADDRESS=127.0.0.1:<pluginListenPort>
   pluginServerPort  : UDP port the AC server listens on -> server_cfg.ini  UDP_PLUGIN_LOCAL_PORT=<pluginServerPort>
   Every server needs its OWN pair of plugin ports. Delete the entries you don't use. */
module.exports = {
    servers: [
        { id: 'akina',   type: 'touge', name: 'Akina',        desc: 'DRS Racing | Touge | Time Attack & Battles', publicIp: '127.0.0.1', acHost: '127.0.0.1', httpPort: 8081, pluginListenPort: 12001, pluginServerPort: 12000, maxClients: 32 },
        { id: 'akagi',   type: 'touge', name: 'Akagi',        desc: 'DRS Racing | Main Server | Touge',           publicIp: '127.0.0.1', acHost: '127.0.0.1', httpPort: 8082, pluginListenPort: 12003, pluginServerPort: 12002, maxClients: 32 },
        { id: 'shomaru', type: 'touge', name: 'Shomaru Pass', desc: 'DRS Racing | Shomaru Only | Time Attack',    publicIp: '127.0.0.1', acHost: '127.0.0.1', httpPort: 8083, pluginListenPort: 12005, pluginServerPort: 12004, maxClients: 32 },
        { id: 'gt3-sprint',    type: 'gt3', name: 'GT3 Sprint',    desc: 'DRS Racing | GT3 Ranked | Weekly Sprint', publicIp: '127.0.0.1', acHost: '127.0.0.1', httpPort: 8091, pluginListenPort: 12007, pluginServerPort: 12006, maxClients: 24 },
        { id: 'gt3-endurance', type: 'gt3', name: 'GT3 Endurance', desc: 'DRS Racing | GT3 Ranked | Endurance',     publicIp: '127.0.0.1', acHost: '127.0.0.1', httpPort: 8092, pluginListenPort: 12009, pluginServerPort: 12008, maxClients: 24 },
    ],

    /* Optional display-name overrides. Key = the folder name the server reports (lower-case). */
    names: {
        tracks: { /* 'touge_akina': 'Akina' */ },
        cars:   { /* 'ks_toyota_ae86': 'Toyota AE86' */ },
    },
};
