// bcdn link generator — standalone cli
// creates bunny.net accounts + pull zones and prints the b-cdn links.
// replaces the old discord-bot front end; same core, no discord/db.

import 'dotenv/config';
import { initHarvester, snipe, snipeBatch } from './sniper.js';
import fs from 'fs';

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
}

const amount = parseInt(arg('amount', '1'), 10);
const origin = arg('origin', null);
const linksPerAccount = parseInt(arg('links-per-account', '1'), 10);

const stage = (m) => console.log('[*]', typeof m === 'string' ? m : JSON.stringify(m));

(async () => {
    console.log(`generating ${amount} link(s)${origin ? ` for origin ${origin}` : ''}...`);
    await initHarvester();
    const opts = { origin, linksPerAccount };
    const accountsNeeded = Math.ceil(amount / linksPerAccount);
    const links = [];
    try {
        if (accountsNeeded === 1) {
            const r = await snipe(stage, opts);
            const zones = r.pullZones || [r];
            for (const z of zones) { console.log('OK', z.bcdnUrl); links.push(z.bcdnUrl); }
            fs.writeFileSync('result.json', JSON.stringify(r, null, 2));
        } else {
            const batch = await snipeBatch(accountsNeeded, stage, opts);
            for (const r of batch.results) { console.log('OK', r.bcdnUrl); links.push(r.bcdnUrl); }
            console.log(`\n${batch.created} created, ${batch.failed} failed`);
            fs.writeFileSync('result.json', JSON.stringify(batch, null, 2));
        }
        fs.writeFileSync('bcdn_links.txt', links.join('\n') + '\n');
        console.log(`\nwrote ${links.length} link(s) to bcdn_links.txt (creds in result.json)`);
    } catch (e) {
        console.error('failed:', e.message);
    }
    process.exit(0);
})();
