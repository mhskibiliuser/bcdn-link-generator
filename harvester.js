import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROFILE_DIR = path.join(__dirname, 'warm-profile');
const BUNNY_REGISTER = 'https://panel.bunny.net/user/register';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// warmup sites — visited periodically to build google trust
const WARMUP_URLS = [
    'https://www.google.com/',
    'https://www.google.com/search?q=bunny+cdn+pricing',
    'https://www.youtube.com/',
];

let _browser = null;
let _proxyHost = null;
let _proxyPort = null;
let _proxyUser = null;
let _proxyPass = null;
let _currentSessionId = null;
let _warmupTimer = null;
let _warmupCount = 0;
let _lastWarmup = 0;
let _log = console.log;

function setLogger(fn) { _log = fn; }

// generate new sticky session id
function newSessionId() {
    return Math.random().toString(36).slice(2, 12);
}

// build proxy password with sticky session
function proxyPassWithSession(sessionId) {
    return `${_proxyPass}_session-${sessionId}_lifetime-30m`;
}

// init browser with proxy
async function init(proxyStr, log) {
    if (log) _log = log;
    const [host, port, user, pass] = proxyStr.split(':');
    _proxyHost = host;
    _proxyPort = port;
    _proxyUser = user;
    _proxyPass = pass;

    _currentSessionId = newSessionId();
    const sessPass = proxyPassWithSession(_currentSessionId);

    _log(`[harvester] init session=${_currentSessionId}`);
    _browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        channel: 'chrome',
        proxy: { server: `http://${host}:${port}`, username: user, password: sessPass },
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        userAgent: CHROME_UA,
        args: ['--disable-blink-features=AutomationControlled']
    });

    // patch navigator.webdriver
    const page = _browser.pages()[0] || await _browser.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // initial warmup
    await warmup();

    // schedule periodic warmup
    _warmupTimer = setInterval(() => warmup().catch(e => _log(`[harvester] warmup err: ${e.message.slice(0, 80)}`)), 20 * 60 * 1000);

    _log(`[harvester] ready`);
}

// build google trust cookies via request api
// (page.goto google hangs through proxy, but ctx.request works and cookies share jar)
async function warmup() {
    if (!_browser) return;
    _warmupCount++;
    _log(`[harvester] warmup #${_warmupCount}...`);

    // spin up page on a neutral site first
    try {
        const page = _browser.pages()[0] || await _browser.newPage();
        await page.goto('https://api.ipify.org', { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
    } catch {}

    // fetch google sites via request api — sets cookies in shared jar
    for (const url of WARMUP_URLS) {
        try {
            const r = await _browser.request.get(url, { timeout: 15000 });
            _log(`[harvester] warm ${url.slice(0, 42)} ${r.status()}`);
            await new Promise(res => setTimeout(res, 800 + Math.random() * 1200));
        } catch (e) {
            _log(`[harvester] warm skip ${url.slice(0, 42)}: ${e.message.slice(0, 50)}`);
        }
    }

    _lastWarmup = Date.now();
    _log(`[harvester] warmup #${_warmupCount} done`);
}

// rotate to fresh ip — new sticky session, keep profile dir
async function rotateIp() {
    if (!_browser) throw new Error('harvester not initialized');
    _currentSessionId = newSessionId();
    _log(`[harvester] rotating ip, session=${_currentSessionId}`);

    // close old first — persistent context holds a singleton lock on PROFILE_DIR
    const oldBrowser = _browser;
    _browser = null;
    await oldBrowser.close().catch(() => {});

    const sessPass = proxyPassWithSession(_currentSessionId);
    _browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        channel: 'chrome',
        proxy: { server: `http://${_proxyHost}:${_proxyPort}`, username: _proxyUser, password: sessPass },
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        userAgent: CHROME_UA,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = _browser.pages()[0] || await _browser.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // verify new ip
    try {
        const ipInfo = await page.evaluate(async () => {
            const r = await fetch('https://api.ipify.org?format=json');
            return r.json();
        });
        _log(`[harvester] new ip=${ipInfo?.ip || '?'}`);
    } catch {}
}

// solve recaptcha v3 on bunny register using the warm browser
async function solveToken(log) {
    if (!_browser) throw new Error('harvester not initialized');
    const _l = log || _log;
    const page = _browser.pages()[0] || await _browser.newPage();

    // navigate to register (networkidle cuts it close through proxy, use domcontentloaded + explicit wait)
    await page.goto(BUNNY_REGISTER, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // wait for grecaptcha to load
    await page.waitForFunction(() => window.grecaptcha?.execute, null, { timeout: 20000 }).catch(() => {});

    // extract sitekey
    const sitekey = await page.evaluate(() => {
        const s = document.querySelector('script[src*="recaptcha/api.js"]');
        if (!s) return null;
        const m = s.src.match(/[?&]render=([\w-]+)/);
        return m ? m[1] : null;
    });
    if (!sitekey) throw new Error('no sitekey found');

    // human behavior before solve
    await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 300));
    await page.waitForTimeout(300 + Math.random() * 400);
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
        await page.mouse.move(100 + Math.random() * 900, 50 + Math.random() * 600);
        await page.waitForTimeout(80 + Math.random() * 150);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // execute recaptcha in-page — this is the key: google's JS runs in OUR warm browser
    const token = await page.evaluate(async (sk) => {
        return new Promise((resolve, reject) => {
            if (!window.grecaptcha?.execute) return reject(new Error('grecaptcha not loaded'));
            window.grecaptcha.execute(sk, { action: 'SIGNUP' }).then(resolve).catch(reject);
        });
    }, sitekey);

    if (!token || token.length < 100) throw new Error('empty token');
    _l(`[harvester] token len=${token.length}`);
    return { token, sitekey, page };
}

// full signup flow: rotate ip → solve token → fill form → submit
// returns same status format as bunnyFullFlow
async function signupWithWarmBrowser(email, password, verifyFn, log) {
    const _l = log || _log;

    // rotate to fresh ip for this signup
    await rotateIp();

    const { token, page } = await solveToken(_l);

    // fill form
    await page.click('#input-email');
    await page.waitForTimeout(150 + Math.random() * 200);
    await page.keyboard.type(email, { delay: 25 + Math.random() * 35 });
    await page.waitForTimeout(200 + Math.random() * 300);

    await page.click('#input-password');
    await page.waitForTimeout(150 + Math.random() * 200);
    await page.keyboard.type(password, { delay: 25 + Math.random() * 35 });
    await page.waitForTimeout(300 + Math.random() * 400);

    const checked = await page.evaluate(() => document.getElementById('AcceptTerms')?.checked);
    if (!checked) await page.click('label[for="AcceptTerms"]');
    await page.waitForTimeout(400 + Math.random() * 600);

    // inject token
    await page.evaluate((t) => {
        const el = document.getElementById('captcha');
        if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, token);
    await page.waitForTimeout(300);

    // submit
    await Promise.all([
        page.waitForNavigation({ timeout: 20000 }).catch(() => null),
        page.click('#signup-button')
    ]);
    await page.waitForTimeout(2000);

    const postUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText?.slice(0, 1000));
    _l(`post-submit url=${postUrl.split('/').pop()}`);

    if (pageText.includes('Account Temporarily Disabled')) return { status: 'FLAGGED' };
    if (pageText.includes('Captcha verification failed')) return { status: 'CAPTCHA_REJECTED' };
    if (pageText.includes('already exists') || pageText.includes('already in use')) return { status: 'EMAIL_EXISTS' };
    if (pageText.includes('contact support') || pageText.includes('Contact Support')) return { status: 'FLAGGED' };
    if (postUrl.includes('/register') && pageText.includes('Sign Up')) return { status: 'CAPTCHA_REJECTED' };

    // signup ok — verify email
    _l('signup ok, verifying...');
    const verifyLink = await verifyFn();
    if (!verifyLink) return { status: 'VERIFY_FAILED' };

    await fetch(verifyLink, { redirect: 'follow' });
    _l('email verified');
    await page.waitForTimeout(1000);

    // get api key
    await page.goto('https://panel.bunny.net/account', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const dashText = await page.evaluate(() => document.body.innerText?.slice(0, 500));
    if (dashText.includes('Temporarily Disabled') || dashText.includes('flagged')) {
        return { status: 'FLAGGED' };
    }

    try { await page.click('#show-api-key-button', { timeout: 3000 }); await page.waitForTimeout(500); } catch {}

    let apiKey = await page.evaluate(() => {
        const el = document.getElementById('api-key-inputfield');
        return el?.value?.length > 30 && !el.value.includes('\u25CF') ? el.value : null;
    });

    if (!apiKey) {
        apiKey = await page.evaluate(async () => {
            try {
                const r = await fetch('/api/apikey', { credentials: 'same-origin' });
                if (r.ok) { const t = await r.text(); const v = t.replace(/"/g, '').trim(); return v.length > 30 ? v : null; }
            } catch {} return null;
        });
    }

    if (!apiKey) return { status: 'NO_API_KEY' };
    _l(`api key: ${apiKey.slice(0, 12)}...`);
    return { status: 'SUCCESS', apiKey };
}

async function shutdown() {
    if (_warmupTimer) clearInterval(_warmupTimer);
    if (_browser) await _browser.close().catch(() => {});
    _browser = null;
    _log('[harvester] shutdown');
}

export { init, warmup, rotateIp, solveToken, signupWithWarmBrowser, shutdown, setLogger };
