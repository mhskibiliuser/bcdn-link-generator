import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_ORIGIN = process.env.BCDN_ORIGIN || 'http://your-origin-server.example.com';
const SMSBOWER_API = 'https://smsbower.page/api/mail';
const SMAILPRO_API = 'https://app.sonjj.com';

// delay between batch signups
const BASE_DELAY = 10000;   // 10s base
const DELAY_RAMP = 0;       // no ramp, proxy rotates IP anyway

// api keys
let _smsbowerKey = null;
let _smailproKey = null;
let _capmonsterKey = null;

let _capsolverKey = null;
function loadCapsolver() {
    if (!_capsolverKey) _capsolverKey = process.env.CAPSOLVER_KEY;
}

function loadCapmonster() {
    if (!_capmonsterKey) _capmonsterKey = process.env.CAPMONSTER_KEY;
}

// match capsolver's chrome 146 macos pool exactly
const FF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
async function solveRecaptchaV3Capsolver(sitekey, pageUrl, action, log, proxy) {
    loadCapsolver();
    if (!_capsolverKey) throw new Error('CAPSOLVER_KEY required');

    // proxy task uses the proxy IP for solve so score matches submit IP
    const task = proxy ? {
        type: 'ReCaptchaV3EnterpriseTask',
        websiteURL: pageUrl,
        websiteKey: sitekey,
        pageAction: action || 'register',
        minScore: 0.9,
        userAgent: FF_UA,
        proxyType: 'http',
        proxyAddress: proxy.host,
        proxyPort: parseInt(proxy.port, 10),
        proxyLogin: proxy.user,
        proxyPassword: proxy.pass
    } : {
        type: 'ReCaptchaV3EnterpriseTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: sitekey,
        pageAction: action || 'register',
        minScore: 0.9,
        userAgent: FF_UA
    };
    log(`capsolver task=${task.type}`);

    const createRes = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: _capsolverKey, task })
    });
    const createData = await createRes.json();
    if (createData.errorId) throw new Error('capsolver create: ' + (createData.errorCode || createData.errorDescription));
    const taskId = createData.taskId;

    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await fetch('https://api.capsolver.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: _capsolverKey, taskId })
        });
        const data = await res.json();
        if (data.status === 'ready') {
            const sol = { ...data.solution };
            if (sol.gRecaptchaResponse) sol.gRecaptchaResponse = `<${sol.gRecaptchaResponse.length}b>`;
            log(`capsolver solved sol=${JSON.stringify(sol).slice(0, 400)}`);
            return data.solution?.gRecaptchaResponse;
        }
        if (data.errorId) throw new Error('capsolver get: ' + (data.errorCode || data.errorDescription));
    }
    throw new Error('capsolver solve timeout');
}

// 2captcha v3 — returns score, retries until min_score hit
let _twocaptchaKey = null;
async function solveRecaptchaV3Twocaptcha(sitekey, pageUrl, action, log) {
    if (!_twocaptchaKey) _twocaptchaKey = process.env.TWOCAPTCHA_KEY;
    if (!_twocaptchaKey) throw new Error('TWOCAPTCHA_KEY required');

    const params = new URLSearchParams({
        key: _twocaptchaKey,
        method: 'userrecaptcha',
        version: 'v3',
        googlekey: sitekey,
        pageurl: pageUrl,
        action: action || 'register',
        min_score: '0.9',
        json: '1'
    });
    const inRes = await fetch(`https://2captcha.com/in.php?${params}`);
    const inData = await inRes.json();
    if (inData.status !== 1) throw new Error('2captcha in: ' + inData.request);
    const taskId = inData.request;
    log(`2captcha task=${taskId}`);

    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const res = await fetch(`https://2captcha.com/res.php?key=${_twocaptchaKey}&action=get&id=${taskId}&json=1`);
        const data = await res.json();
        if (data.status === 1) {
            log(`2captcha solved len=${(data.request || '').length}`);
            return data.request;
        }
        if (data.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha get: ' + data.request);
    }
    throw new Error('2captcha solve timeout');
}

// solve recaptcha v3 — capsolver first (chromium pool), 2captcha fallback
async function solveRecaptchaV3(sitekey, pageUrl, action, log, proxy) {
    loadCapsolver();
    if (_capsolverKey) {
        try { return await solveRecaptchaV3Capsolver(sitekey, pageUrl, action, log, proxy); }
        catch (e) { log(`capsolver err: ${e.message.slice(0, 100)}, trying 2captcha`); }
    }
    if (process.env.TWOCAPTCHA_KEY) {
        try { return await solveRecaptchaV3Twocaptcha(sitekey, pageUrl, action, log); }
        catch (e) { log(`2captcha err: ${e.message.slice(0, 100)}, trying capmonster`); }
    }
    loadCapmonster();
    if (!_capmonsterKey) throw new Error('no captcha solver configured');

    const createRes = await fetch('https://api.capmonster.cloud/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientKey: _capmonsterKey,
            task: {
                type: 'RecaptchaV3TaskProxyless',
                websiteURL: pageUrl,
                websiteKey: sitekey,
                minScore: 0.7,
                pageAction: action || 'register'
            }
        })
    });
    const createData = await createRes.json();
    if (createData.errorId) throw new Error('cap create: ' + (createData.errorCode || createData.errorDescription));
    const taskId = createData.taskId;

    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await fetch('https://api.capmonster.cloud/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: _capmonsterKey, taskId })
        });
        const data = await res.json();
        if (data.status === 'ready') {
            log(`capmonster solved sol=${JSON.stringify(data.solution || {}).slice(0, 200)}`);
            return data.solution?.gRecaptchaResponse;
        }
        if (data.errorId) throw new Error('cap get: ' + (data.errorCode || data.errorDescription));
    }
    throw new Error('recaptcha solve timeout');
}

function loadSmsbower() {
    if (!_smsbowerKey) {
        _smsbowerKey = process.env.SMSBOWER_KEY;
    }
}

function loadSmailpro() {
    if (!_smailproKey) {
        _smailproKey = process.env.SMAILPRO_KEY;
    }
}

// proxy list
let _proxies = null;
let _proxyIdx = 0;

function loadProxies() {
    if (_proxies === null) {
        _proxies = process.env.PROXIES ? process.env.PROXIES.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : [];
    }
    return _proxies;
}

function nextProxy() {
    const proxies = loadProxies();
    if (!proxies.length) return '';
    const p = proxies[_proxyIdx % proxies.length];
    _proxyIdx++;
    return p;
}

function getProxyParts(proxy) {
    const [host, port, user, pass] = proxy.split(':');
    return { host, port, user, pass, url: `http://${user}:${pass}@${host}:${port}` };
}

function randomPzName() {
    const adj = ['swift','bright','clear','fast','prime','fresh','smart','sharp','clean','bold','quick','lite','next','pure','apex','rapid','ultra','hyper','mega','super'];
    const noun = ['cdn','edge','cache','net','hub','link','web','site','dash','host','zone','beam','flux','wave','node','core','pipe','volt','path','grid'];
    return adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)] + (Math.floor(Math.random() * 9000) + 1000);
}

// smailpro: get random gmail (~2.3 credits per link)
async function getSmailproEmail(log) {
    loadSmailpro();
    if (!_smailproKey) return null;
    try {
        const res = await fetch(`${SMAILPRO_API}/v1/temp_gmail/random`, {
            headers: { 'X-Api-Key': _smailproKey, 'Accept': 'application/json' }
        });
        if (!res.ok) {
            const err = await res.text();
            log(`smailpro err: ${res.status} ${err.slice(0, 80)}`);
            return null;
        }
        const data = await res.json();
        if (!data.email) return null;
        log(`got gmail: ${data.email} (~$0.002 smailpro)`);
        return { email: data.email, timestamp: data.timestamp, provider: 'smailpro' };
    } catch (e) {
        log(`smailpro fetch err: ${e.message.slice(0, 60)}`);
        return null;
    }
}

// smailpro: poll inbox for link matching predicate
async function getVerifyLinkSmailpro(email, timestamp, log, matcher, maxWait = 180000) {
    const match = matcher || ((l) => /bunny/i.test(l) && /(confirmemail|verif|confirm|activate|token|auth)/i.test(l));
    const deadline = Date.now() + maxWait;
    for (let i = 0; Date.now() < deadline; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 8000));
        try {
            const res = await fetch(`${SMAILPRO_API}/v1/temp_gmail/inbox?email=${encodeURIComponent(email)}&timestamp=${timestamp}`, {
                headers: { 'X-Api-Key': _smailproKey, 'Accept': 'application/json' }
            });
            const data = await res.json();
            if (data.messages?.length > 0) {
                for (const msg of data.messages) {
                    const msgRes = await fetch(`${SMAILPRO_API}/v1/temp_gmail/message?email=${encodeURIComponent(email)}&mid=${msg.mid}`, {
                        headers: { 'X-Api-Key': _smailproKey, 'Accept': 'application/json' }
                    });
                    const msgData = await msgRes.json();
                    const body = msgData.body || msgData.html || msgData.textBody || JSON.stringify(msgData);
                    const links = body.match(/https?:\/\/[^\s"<>]+/g) || [];
                    log(`[mail] subj="${(msgData.subject || '').slice(0, 50)}" from="${(msgData.from || '').slice(0, 40)}" links=${links.filter(l => /bunny/i.test(l)).slice(0, 6).join(' ').slice(0, 400)}`);
                    const verifyLink = links.find(match);
                    if (verifyLink) { log('got verify link'); return verifyLink; }
                    // maybe link in subject or snippet
                    const allText = JSON.stringify(msgData);
                    const allLinks = allText.match(/https?:\/\/[^\s"<>\\]+/g) || [];
                    const vl2 = allLinks.find(match);
                    if (vl2) { log('got verify link (deep)'); return vl2; }
                }
            }
        } catch (e) {
            log(`inbox poll err: ${e.message.slice(0, 60)}`);
        }
        if (i % 3 === 2) log(`waiting for email... ${(i + 1) * 8}s`);
    }
    return null;
}

// smsbower: get email (fallback)
const CHEAP_DOMAINS = ['mailnestpro.com', 'hihinail.com', 'flytempbox.com', 'mailburstx.com'];

async function getSmsbowerEmail(log) {
    loadSmsbower();
    if (!_smsbowerKey) return null;
    for (const domain of CHEAP_DOMAINS) {
        try {
            const res = await fetch(`${SMSBOWER_API}/getActivation?api_key=${_smsbowerKey}&service=ot&domain=${domain}`);
            const data = await res.json();
            if (data.status === 1 && data.mail) {
                log(`got email: ${data.mail} ($0.01)`);
                return { email: data.mail, mailId: data.mailId, provider: 'smsbower' };
            }
        } catch {}
    }
    const res = await fetch(`${SMSBOWER_API}/getActivation?api_key=${_smsbowerKey}&service=ot&domain=gmail.com`);
    const data = await res.json();
    if (data.status !== 1 || !data.mail) return null;
    log(`got gmail: ${data.mail} ($0.11 smsbower)`);
    return { email: data.mail, mailId: data.mailId, provider: 'smsbower' };
}

// smsbower: poll for verify link
async function getVerifyLinkSmsbower(mailId, log, matcher, maxWait = 180000) {
    loadSmsbower();
    const match = matcher || ((l) => l.includes('confirmemail'));
    const deadline = Date.now() + maxWait;
    for (let i = 0; Date.now() < deadline; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 8000));
        const res = await fetch(`${SMSBOWER_API}/getCode?api_key=${_smsbowerKey}&mailId=${mailId}`);
        const data = await res.json();
        if (data.status === 1 && data.code) {
            const links = data.code.match(/https?:\/\/[^\s"<>]+/g) || [];
            const verifyLink = links.find(match);
            if (verifyLink) {
                log('got verify link');
                await fetch(`${SMSBOWER_API}/setStatus?api_key=${_smsbowerKey}&id=${mailId}&status=3`).catch(() => {});
                return verifyLink;
            }
        }
        if (i % 3 === 2) log(`waiting for email... ${(i + 1) * 8}s`);
    }
    await fetch(`${SMSBOWER_API}/setStatus?api_key=${_smsbowerKey}&id=${mailId}&status=2`).catch(() => {});
    return null;
}

// unified: get email (smailpro first, smsbower fallback)
async function getEmail(log) {
    const sp = await getSmailproEmail(log);
    if (sp) return sp;
    const sb = await getSmsbowerEmail(log);
    if (sb) return sb;
    throw new Error('no email provider available');
}

// unified: get verify link — matcher defaults to bunny confirmemail
async function getVerifyLink(emailData, log, matcher, maxWait) {
    if (emailData.provider === 'smailpro') {
        return getVerifyLinkSmailpro(emailData.email, emailData.timestamp, log, matcher, maxWait);
    }
    return getVerifyLinkSmsbower(emailData.mailId, log, matcher, maxWait);
}

// cancel smsbower activation (refund)
async function cancelEmail(emailData) {
    if (emailData.provider === 'smsbower' && emailData.mailId) {
        try { await fetch(`${SMSBOWER_API}/setStatus?api_key=${_smsbowerKey}&id=${emailData.mailId}&status=2`); } catch {}
    }
}

// get the account api key on the new dash: capture the spa's jwt, then call api.bunny.net
// from the box directly (NOT through the browser proxy — that path hangs; the box reaches the api fine)
async function extractApiKeyDash(page, log) {
    const guidRe = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
    let bearer = null;
    const onReq = (req) => {
        const a = req.headers()['authorization'];
        // bunny sends the raw jwt as the Authorization value (no "Bearer " prefix)
        if (a && a.length > 20 && /api\.bunny\.net/i.test(req.url()) && !bearer) { bearer = a; log('bearer captured'); }
    };
    page.on('request', onReq);
    // poke the spa so it calls api.bunny.net with the jwt (works even on the onboarding screen)
    for (const url of ['https://dash.bunny.net/account', 'https://dash.bunny.net/billing']) {
        if (bearer) break;
        try { await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }); await page.waitForTimeout(2500); } catch {}
    }
    page.off('request', onReq);
    if (!bearer) { log('no bearer captured'); return null; }

    const hdr = { 'Authorization': bearer, 'Accept': 'application/json' };
    // the AccessKey is the full "Key" string (64 chars), NOT a single guid — use it as-is
    const pickKey = (obj) => { for (const f of ['Key', 'ApiKey', 'AccessKey', 'Value']) { if (obj && typeof obj[f] === 'string' && obj[f].length >= 30) return obj[f]; } return null; };

    // existing account api key
    try {
        const r = await fetch('https://api.bunny.net/apikey?page=1&perPage=1000', { headers: hdr });
        if (r.ok) {
            const items = ((await r.json()).Items) || [];
            for (const it of items) { const k = pickKey(it); if (k) { log('api key via GET /apikey'); return k; } }
        } else { log(`GET /apikey ${r.status}`); }
    } catch (e) { log(`GET /apikey err ${e.message.slice(0, 60)}`); }

    // none yet — create one
    for (const body of ['{"Name":"cdn"}', '{}']) {
        try {
            const r = await fetch('https://api.bunny.net/apikey', { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' }, body });
            if (r.ok) { const k = pickKey(await r.json().catch(() => ({}))); if (k) { log('api key via POST /apikey'); return k; } }
            else log(`POST /apikey ${r.status}`);
        } catch (e) { log(`POST /apikey err ${e.message.slice(0, 60)}`); }
    }
    return null;
}

// single browser session: signup → verify → get api key
async function bunnyFullFlow(email, password, proxy, verifyFn, log, onBrowser) {
    // unique profile per call so parallel races don't collide on lockfile
    const profileDir = path.join(__dirname, 'chromium-profiles', `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const pp = getProxyParts(proxy);
    // sticky session — same exit ip for solve + submit
    const sessionId = Math.random().toString(36).slice(2, 12);
    pp.pass = `${pp.pass}_session-${sessionId}_lifetime-10m`;
    log(`sticky session=${sessionId}`);
    const browser = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        proxy: { server: `http://${pp.host}:${pp.port}`, username: pp.user, password: pp.pass },
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        userAgent: FF_UA
    });
    onBrowser?.(browser);

    try {
        const page = browser.pages()[0] || await browser.newPage();
        await browser.clearCookies({ domain: 'panel.bunny.net' }).catch(() => {});
        await browser.clearCookies({ domain: '.bunny.net' }).catch(() => {});
        // also clear google cookies — repeat attempts on same cookie id tank score
        await browser.clearCookies({ domain: '.google.com' }).catch(() => {});
        await browser.clearCookies({ domain: 'www.google.com' }).catch(() => {});

        // ip + ua diag
        try {
            const ipInfo = await page.evaluate(async () => {
                try {
                    const r = await fetch('https://api.ipify.org?format=json');
                    return await r.json();
                } catch (e) { return { error: String(e) }; }
            });
            log(`exit ip=${ipInfo?.ip || ipInfo?.error || '?'}`);
        } catch {}

        const pageUrl = 'https://dash.bunny.net/auth/register';

        // capture the register api call (angular spa) for diag + success detection
        page.on('response', async (res) => {
            const u = res.url();
            if (res.request().method() === 'POST' && /register|signup|account|user/i.test(u) && !/cap\.prod|matomo|google|gstatic|jsdelivr/i.test(u)) {
                try {
                    const txt = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
                    log(`REG-RESP ${res.status()} ${u.slice(0, 70)} body=${txt}`);
                } catch {}
            }
        });

        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(1500);

        const emailSel = 'input[type="email"]';
        const passSel = 'input[type="password"]';
        try { await page.waitForSelector(emailSel, { timeout: 15000 }); }
        catch { return { status: 'ERROR', error: 'register form not found' }; }

        // light human movement while cap solves in the background
        await page.mouse.move(200 + Math.random() * 600, 200 + Math.random() * 300);
        await page.waitForTimeout(200 + Math.random() * 300);

        // fill email + password (new dash form has no element ids)
        await page.click(emailSel);
        await page.waitForTimeout(120 + Math.random() * 180);
        await page.keyboard.type(email, { delay: 25 + Math.random() * 35 });
        await page.waitForTimeout(200 + Math.random() * 300);

        await page.click(passSel);
        await page.waitForTimeout(120 + Math.random() * 180);
        await page.keyboard.type(password, { delay: 25 + Math.random() * 35 });
        await page.waitForTimeout(300 + Math.random() * 400);

        // accept terms checkbox
        try {
            const cb = await page.$('input[type="checkbox"]');
            if (cb && !(await cb.isChecked().catch(() => false))) {
                await cb.click({ force: true }).catch(async () => { await page.click('bn-web-ui-checkbox', { force: true }).catch(() => {}); });
            }
        } catch {}
        await page.waitForTimeout(300);

        // Cap proof-of-work — widget solves in-browser; wait for the hidden cap-token
        log('waiting for cap PoW token...');
        let capToken = null;
        const capDeadline = Date.now() + 90000;
        while (Date.now() < capDeadline) {
            capToken = await page.evaluate(() => {
                const el = document.querySelector('input[name="cap-token"]');
                return el && el.value && el.value.length > 5 ? el.value : null;
            });
            if (capToken) break;
            await page.waitForTimeout(1000);
        }
        log(capToken ? `cap token len=${capToken.length}` : 'cap token not populated (submitting anyway)');

        // submit
        await Promise.all([
            page.waitForNavigation({ timeout: 25000 }).catch(() => null),
            page.click('button:has-text("Create an Account")').catch(() => page.click('button[type="submit"]').catch(() => {}))
        ]);
        await page.waitForTimeout(3500);

        const postUrl = page.url();
        const pageText = (await page.evaluate(() => document.body.innerText?.slice(0, 1000))) || '';
        log(`diag url=${postUrl}`);
        log(`diag text=${pageText.replace(/\s+/g, ' ').slice(0, 300)}`);

        if (postUrl.includes('chrome-error://') || postUrl.includes('about:blank')) return { status: 'ERROR', error: 'proxy/network error' };
        if (/already (exists|in use|registered|taken)/i.test(pageText)) return { status: 'EMAIL_EXISTS' };
        if (/temporarily disabled|contact support/i.test(pageText)) return { status: 'FLAGGED' };
        if (/captcha/i.test(pageText) && /fail|invalid/i.test(pageText)) return { status: 'CAPTCHA_REJECTED' };
        // success = left the register page (to a verify-email screen or dashboard)
        if (/\/auth\/register/.test(postUrl) && !/verif|confirm|check your|inbox|e-?mail sent/i.test(pageText)) {
            return { status: 'CAPTCHA_REJECTED', error: 'still on register: ' + pageText.replace(/\s+/g, ' ').slice(0, 120) };
        }

        // account is logged in immediately after signup — grab the api key first
        log('signup ok');
        await page.waitForTimeout(1000);
        const apiKey = await extractApiKeyDash(page, log);
        if (!apiKey) return { status: 'NO_API_KEY' };
        log(`api key: ${apiKey.slice(0, 12)}...`);

        // bunny now blocks zone creation on unverified accounts ("not allowed to add new zones").
        // verify the email (poll inbox for the link, then hit it) to lift the restriction.
        log('verifying email...');
        try {
            const verifyLink = await verifyFn();
            if (verifyLink) {
                await fetch(verifyLink, { redirect: 'follow' }).catch(() => {});
                log('email verified');
                await page.waitForTimeout(1500);
            } else {
                log('NO verify link found');
            }
        } catch (e) { log('verify err: ' + e.message.slice(0, 60)); }
        return { status: 'SUCCESS', apiKey };
    } finally {
        await browser.close().catch(() => {});
        await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
}

// race N parallel signups, first SUCCESS wins, kill the rest
async function raceBunnySignup(email, password, verifyFn, log, parallelism) {
    const browsers = new Array(parallelism).fill(null);
    let won = false;

    const runOne = async (idx) => {
        const proxy = nextProxy();
        const tag = `[w${idx + 1}]`;
        const flowLog = (m) => log(`${tag} ${m}`);
        try {
            const result = await bunnyFullFlow(email, password, proxy, verifyFn, flowLog, (b) => { browsers[idx] = b; });
            if (result.status === 'SUCCESS' && !won) {
                won = true;
                // kill losing browsers — they'll exit early
                browsers.forEach((b, j) => { if (j !== idx && b) b.close().catch(() => {}); });
            }
            return result;
        } catch (e) {
            return { status: 'ERROR', error: e.message.slice(0, 100) };
        }
    };

    log(`racing ${parallelism} parallel attempts...`);
    const results = await Promise.all(Array.from({ length: parallelism }, (_, i) => runOne(i)));
    // prefer SUCCESS, then EMAIL_EXISTS, then anything
    return results.find(r => r.status === 'SUCCESS')
        || results.find(r => r.status === 'EMAIL_EXISTS')
        || results[0];
}

// create pull zone via API
async function createPullZone(apiKey, log, originUrl) {
    const origin = originUrl || DEFAULT_ORIGIN;
    const pzName = randomPzName();
    log(`creating pull zone ${pzName}...`);

    const pzRes = await fetch('https://api.bunny.net/pullzone', {
        method: 'POST',
        headers: { 'AccessKey': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            Name: pzName, OriginUrl: origin, AddHostHeader: true,
            EnableGeoZoneUS: true, EnableGeoZoneEU: true, EnableGeoZoneASIA: true,
            EnableGeoZoneSA: true, EnableGeoZoneAF: true,
            CacheControlPublicMaxAgeOverride: -1, EnableCacheSlice: false,
            EnableQueryStringOrdering: false, EnableAccessControlOriginHeader: true,
            VerifyOriginSSL: false, FollowRedirects: false
        })
    });

    if (!pzRes.ok) {
        const e = await pzRes.text();
        if (e.includes('restricted') || e.includes('suspended') || e.includes('locked'))
            throw new Error('ACCOUNT_RESTRICTED: ' + e.slice(0, 200));
        throw new Error(`pull zone: ${pzRes.status} ${e.slice(0, 200)}`);
    }

    const pzData = await pzRes.json();
    const pullZoneId = pzData.Id;
    const bcdnUrl = `https://${pzName}.b-cdn.net`;

    // force ssl
    try {
        const defaultHostname = pzData.Hostnames?.find(h => h.Value?.endsWith('.b-cdn.net'));
        if (defaultHostname) {
            await fetch(`https://api.bunny.net/pullzone/${pullZoneId}/setForceSSL`, {
                method: 'POST',
                headers: { 'AccessKey': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ Hostname: defaultHostname.Value, ForceSSL: true })
            });
            log('force SSL enabled');
        }
    } catch {}

    // purge cache
    try {
        await fetch(`https://api.bunny.net/pullzone/${pullZoneId}/purgeCache`, {
            method: 'POST', headers: { 'AccessKey': apiKey }
        });
    } catch {}

    return { pullZoneId, pullZoneName: pzName, bcdnUrl };
}

// full pipeline: email → signup + verify + api key → pull zone
// tries warm harvester first, falls back to 2captcha race
import * as harvester from './harvester.js';
let _harvesterReady = false;

export async function initHarvester() {
    const proxies = loadProxies();
    if (!proxies.length) return;
    try {
        await harvester.init(proxies[0], (m) => console.log(m));
        _harvesterReady = true;
        console.log('[snipe] harvester ready');
    } catch (e) {
        console.log(`[snipe] harvester init failed: ${e.message.slice(0, 80)}, will use 2captcha fallback`);
    }
}

export async function snipe(onStage, opts = {}) {
    const detail = (msg) => console.log('[snipe]', msg);
    const stage = (msg) => { onStage?.(msg); detail(msg); };
    const originUrl = opts.origin || null;
    const linksPerAccount = Math.min(Math.max(opts.linksPerAccount || 1, 1), 20);

    if (!loadProxies().length) throw new Error('no proxies configured');
    loadSmailpro();
    loadSmsbower();

    let emailData = null;
    let email = null;
    let bunnyPass = 'Inf' + crypto.randomBytes(8).toString('base64url') + '!1';
    let result = null;

    // warm browser first (primary path)
    // harvester (warm-browser) path uses the pre-dash signup flow — broken since bunny moved to
    // dash.bunny.net + Cap. skip it; the raceBunnySignup path below handles the new flow + verify.
    if (false && _harvesterReady) {
        const HARVESTER_TRIES = 2;
        for (let attempt = 1; attempt <= HARVESTER_TRIES; attempt++) {
            if (!emailData) {
                stage('getting email...');
                emailData = await getEmail((m) => detail(m));
                email = emailData.email;
                detail(`email: ${email}, provider: ${emailData.provider}`);
            }

            stage(attempt === 1 ? 'warm browser signup...' : `warm browser retry ${attempt}/${HARVESTER_TRIES}...`);
            try {
                result = await harvester.signupWithWarmBrowser(
                    email, bunnyPass,
                    () => getVerifyLink(emailData, (m) => detail(m)),
                    detail
                );
                detail(`warm result: ${result?.status}`);

                if (result?.status === 'SUCCESS') break;
                if (result?.status === 'FLAGGED') {
                    await cancelEmail(emailData);
                    throw new Error('signup flagged by anti-fraud');
                }
                if (result?.status === 'EMAIL_EXISTS') {
                    detail('email taken, getting new one...');
                    await cancelEmail(emailData);
                    emailData = null;
                    continue;
                }
            } catch (e) {
                if (e.message.includes('flagged') || e.message.includes('verification')) throw e;
                detail(`warm attempt ${attempt}: ${e.message.slice(0, 80)}`);
            }
        }
    }

    // capsolver parallel race (fallback)
    const PARALLEL = 4;
    const ROUNDS = 3;
    if (result?.status !== 'SUCCESS') {
      for (let round = 1; round <= ROUNDS; round++) {
        if (!emailData) {
            stage('getting email...');
            emailData = await getEmail((m) => detail(m));
            email = emailData.email;
            detail(`email: ${email}, provider: ${emailData.provider}`);
        }

        stage(round === 1 ? `creating account (${PARALLEL}x parallel)...` : `retry round ${round}/${ROUNDS}...`);

        try {
            result = await raceBunnySignup(email, bunnyPass,
                () => getVerifyLink(emailData, (m) => detail(m)),
                detail, PARALLEL
            );
            detail(`round ${round} result: ${result?.status}${result?.error ? ' — ' + result.error : ''}`);

            if (result?.status === 'SUCCESS') break;
            if (result?.status === 'FLAGGED') {
                await cancelEmail(emailData);
                throw new Error('signup flagged by anti-fraud');
            }
            if (result?.status === 'EMAIL_EXISTS') {
                detail('email taken, getting new one...');
                await cancelEmail(emailData);
                emailData = null;
                continue;
            }
            if (result?.status === 'VERIFY_FAILED') throw new Error('verification email not received');
            if (result?.status === 'NO_API_KEY') throw new Error('could not extract API key');
        } catch (e) {
            if (e.message.includes('flagged') || e.message.includes('verification')) throw e;
            detail(`round ${round}: ${e.message.slice(0, 80)}`);
        }
      }
    }

    if (!result || result.status !== 'SUCCESS') {
        await cancelEmail(emailData);
        throw new Error(`bunny signup failed`);
    }

    // create pull zones
    const pullZones = [];
    for (let i = 0; i < linksPerAccount; i++) {
        stage(linksPerAccount > 1 ? `creating pull zone ${i + 1}/${linksPerAccount}...` : 'creating pull zone...');
        const pz = await createPullZone(result.apiKey, (m) => detail(m), originUrl);
        pullZones.push(pz);
        detail(`created ${pz.bcdnUrl}`);
    }
    stage('done');

    if (linksPerAccount === 1) {
        return {
            email,
            password: bunnyPass,
            apiKey: result.apiKey,
            ...pullZones[0],
            status: 'active'
        };
    }

    return {
        email,
        password: bunnyPass,
        apiKey: result.apiKey,
        pullZones,
        status: 'active'
    };
}

// create additional pull zone on existing account
export async function createLink(apiKey, onProgress, originUrl) {
    const log = (msg) => { onProgress?.(msg); console.log('[snipe]', msg); };
    return createPullZone(apiKey, log, originUrl);
}

// batch snipe with delays
export async function snipeBatch(amount, onStage, opts = {}) {
    const detail = (msg) => console.log('[batch]', msg);
    const stage = (msg) => { onStage?.(msg); detail(msg); };

    if (!loadProxies().length) throw new Error('no proxies configured');
    loadSmailpro();
    loadSmsbower();

    const results = [];
    const errors = [];

    for (let i = 0; i < amount; i++) {
        const tag = `[${i + 1}/${amount}]`;

        // delay between signups (skip first)
        if (i > 0) {
            const delay = BASE_DELAY + (DELAY_RAMP * (i - 1));
            const delaySec = Math.round(delay / 1000);
            stage(`${tag} cooldown ${delaySec}s...`);

            const start = Date.now();
            while (Date.now() - start < delay) {
                const left = Math.ceil((delay - (Date.now() - start)) / 1000);
                if (left % 30 === 0) stage(`${tag} cooldown ${left}s...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        try {
            const result = await snipe((msg) => stage(`${tag} ${msg}`), opts);
            if (result.pullZones) {
                for (const pz of result.pullZones) {
                    results.push({ email: result.email, password: result.password, apiKey: result.apiKey, ...pz, status: 'active' });
                }
            } else {
                results.push(result);
            }
            detail(`${tag} success: ${result.pullZones ? result.pullZones.length + ' links' : result.bcdnUrl}`);
        } catch (e) {
            errors.push({ index: i, error: e.message });
            stage(`${tag} failed`);
            detail(`${tag} failed: ${e.message.slice(0, 100)}`);

            if (e.message.includes('flagged') || e.message.includes('FLAGGED')) {
                stage(`${tag} stopped — flagged`);
                break;
            }
        }
    }

    return { results, errors, total: amount, created: results.length, failed: errors.length };
}

export { getEmail, getVerifyLink, cancelEmail };
