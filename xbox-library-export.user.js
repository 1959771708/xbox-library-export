// ==UserScript==
// @name         Xbox 库存导出
// @name:en      Xbox Library Export
// @namespace    https://github.com/1959771708/xbox-library-export
// @version      1.2.1
// @description  导出 Xbox / 微软商店账号的完整游戏库存与游玩时长（免填授权码、统一英文名与 CN 人民币定价，含未游玩已购游戏、Play Anywhere 与金会员）
// @description:en  Export your complete Xbox / Microsoft Store owned library and playtime to JSON without manual device codes.
// @author       1959771708
// @license      CC-BY-4.0
// @homepageURL  https://github.com/1959771708/xbox-library-export
// @supportURL   https://github.com/1959771708/xbox-library-export/issues
// @updateURL    https://raw.githubusercontent.com/1959771708/xbox-library-export/main/xbox-library-export.user.js
// @downloadURL  https://raw.githubusercontent.com/1959771708/xbox-library-export/main/xbox-library-export.user.js
// @match        https://www.xbox.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      login.microsoftonline.com
// @connect      user.auth.xboxlive.com
// @connect      xsts.auth.xboxlive.com
// @connect      collections.mp.microsoft.com
// @connect      displaycatalog.mp.microsoft.com
// @connect      titlehub.xboxlive.com
// @connect      userstats.xboxlive.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ── 配置 ────────────────────────────────────────────────────────────────
    // xbox.com 网页端自身的公开 OAuth Client ID（支持 PKCE 授权码流 + 静默 iframe 回调 /auth/msa/blank.html）。
    // collections.mp.microsoft.com 会按调用方 client_id 返回库内容，使用该 client_id 才能拿到完整已购库。
    const CLIENT_ID = '1f907974-e22b-4810-a9de-d9647380c97e';
    const SCOPE = 'xboxlive.signin offline_access';
    const AUTH_REDIRECT_URI = 'https://www.xbox.com/auth/msa/blank.html';
    const AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
    const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
    const USER_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
    const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
    const COLLECTIONS_URL = 'https://collections.mp.microsoft.com/v7.0/collections/query';
    const CATALOG_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
    const TITLEHUB_URL = 'https://titlehub.xboxlive.com/users/xuid({xuid})/titles/titlehistory/decoration/detail';
    const USERSTATS_URL = 'https://userstats.xboxlive.com/batch';

    const RP_XBOXLIVE = 'http://xboxlive.com';
    const RP_MARKETPLACE = 'http://mp.microsoft.com/';

    const REFRESH_TOKEN_KEY = 'xbox_export_refresh_token_v1';
    const PRIMARY_MARKET = 'CN';
    const FALLBACK_MARKET = 'US';

    const COLLECTION_PAGE_SIZE = 1000;
    const COLLECTION_MAX_PAGES = 50;
    const CATALOG_BATCH = 20;
    const USERSTATS_BATCH = 50;
    const SILENT_TIMEOUT_MS = 12000;
    const SCHEMA_VERSION = 1;

    const EXTRA_TITLE_RE = /\b(add-?on|upgrade|soundtrack|artbook|season pass|expansion pass|friend'?s pass|dlc|demo|beta|test server)\b/i;
    const NAME_NOISE_RE = /\s*(\((PC|Windows( 10)?)\)|[-–]\s*Windows( 10)?( Edition)?|for Windows( 10)?)\s*$/i;

    const state = {
        running: false,
        cancelled: false,
        result: null,
        startedAt: 0,
        requests: 0,
        ticker: null
    };

    // ── 本地偏好与工具 ──────────────────────────────────────────────────────
    function loadBoolPref(key, fallback) {
        try {
            if (typeof localStorage === 'undefined') return fallback;
            const v = localStorage.getItem(key);
            return v === null ? fallback : v === '1';
        } catch (_) {
            return fallback;
        }
    }

    function saveBoolPref(key, val) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(key, val ? '1' : '0');
            }
        } catch (_) { }
    }

    function loadRefreshToken() {
        try {
            return (typeof localStorage !== 'undefined' && localStorage.getItem(REFRESH_TOKEN_KEY)) || '';
        } catch (_) {
            return '';
        }
    }

    function saveRefreshToken(tok) {
        try {
            if (typeof localStorage !== 'undefined') {
                if (tok) localStorage.setItem(REFRESH_TOKEN_KEY, tok);
                else localStorage.removeItem(REFRESH_TOKEN_KEY);
            }
        } catch (_) { }
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function shortUrl(u) {
        return String(u || '').replace(/^https?:\/\//, '').slice(0, 64);
    }

    function makeCv() {
        let hex = '';
        for (let i = 0; i < 16; i += 1) {
            hex += Math.floor(Math.random() * 16).toString(16).toUpperCase();
        }
        return hex + '.0';
    }

    function chunkArray(list, size) {
        const out = [];
        for (let i = 0; i < list.length; i += size) {
            out.push(list.slice(i, i + size));
        }
        return out;
    }

    function normalizeTitleKey(title) {
        return String(title || '')
            .replace(/[\u2122\u00AE\u00A9]/g, '')
            .replace(NAME_NOISE_RE, '')
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
    }

    function cleanDisplayTitle(title) {
        return String(title || '')
            .replace(NAME_NOISE_RE, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeIsoDate(ts) {
        if (!ts || typeof ts !== 'string') return null;
        const trimmed = ts.trim();
        if (!trimmed) return null;
        const ms = Date.parse(trimmed);
        if (!Number.isFinite(ms) || ms <= 86400000) return null;
        return trimmed;
    }

    function errorCodeOf(err) {
        if (!err) return 'UNKNOWN';
        if (err.code) return String(err.code);
        if (err.status) return 'HTTP_' + err.status;
        if (err.networkProblem) return 'NETWORK_ERROR';
        return 'UNKNOWN';
    }

    // ── GM_xmlhttpRequest 网络层 ────────────────────────────────────────────
    function gmRaw(cfg) {
        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
            return GM.xmlHttpRequest(cfg);
        }
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest(Object.assign({}, cfg, {
                    onload: resolve,
                    onerror: function (e) { reject(e || new Error('GM network error')); },
                    ontimeout: function () {
                        const err = new Error('请求超时 · ' + shortUrl(cfg.url));
                        err.networkProblem = true;
                        reject(err);
                    }
                }));
            });
        }
        const err = new Error('未检测到 GM_xmlhttpRequest，请使用 Tampermonkey / Violentmonkey 运行本脚本');
        err.envProblem = true;
        return Promise.reject(err);
    }

    async function httpRequest(url, opts) {
        const cfg = opts || {};
        const retries = cfg.retries !== undefined ? cfg.retries : 2;
        let lastErr = null;

        for (let attempt = 0; attempt <= retries; attempt += 1) {
            state.requests += 1;
            const started = Date.now();
            try {
                const res = await gmRaw({
                    method: cfg.method || 'GET',
                    url: url,
                    headers: cfg.headers || {},
                    data: cfg.data,
                    timeout: cfg.timeout || 30000,
                    anonymous: cfg.anonymous !== undefined ? cfg.anonymous : true
                });

                const st = res && res.status;
                if (typeof st !== 'number') {
                    const envErr = new Error('未拿到 HTTP 状态码（脚本管理器可能不支持完整 GM_xmlhttpRequest）· ' + shortUrl(url));
                    envErr.envProblem = true;
                    throw envErr;
                }

                const text = res.responseText || '';
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

                if (st < 200 || st >= 300) {
                    const err = new Error((cfg.what || shortUrl(url)) + ' 返回 HTTP ' + st);
                    err.status = st;
                    err.responseText = text;
                    err.json = json;
                    const retryable = st === 429 || st >= 500;
                    if (!retryable || attempt === retries) throw err;
                    lastErr = err;
                    await sleep((st === 429 ? 1200 : 400) * Math.pow(2, attempt) + Math.random() * 150);
                    continue;
                }

                return { status: st, text: text, json: json, ms: Date.now() - started };
            } catch (err) {
                lastErr = err;
                if (err && (err.envProblem || (typeof err.status === 'number' && err.status < 500 && err.status !== 429))) {
                    throw err;
                }
                if (attempt === retries) {
                    if (err && !err.status && !err.envProblem) err.networkProblem = true;
                    throw err;
                }
                await sleep(400 * Math.pow(2, attempt) + Math.random() * 150);
            }
        }
        throw lastErr;
    }

    function formEncode(obj) {
        return Object.keys(obj).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
        }).join('&');
    }

    // ── PKCE 静默 iframe + 一键登录弹窗（免填授权码） ────────────────────────
    function base64Url(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function createPkcePair() {
        const raw = new Uint8Array(32);
        crypto.getRandomValues(raw);
        const verifier = base64Url(raw);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        return { verifier: verifier, challenge: base64Url(new Uint8Array(digest)) };
    }

    function buildAuthorizeUrl(challenge, promptMode) {
        let u = AUTHORIZE_URL
            + '?client_id=' + encodeURIComponent(CLIENT_ID)
            + '&response_type=code'
            + '&redirect_uri=' + encodeURIComponent(AUTH_REDIRECT_URI)
            + '&scope=' + encodeURIComponent(SCOPE)
            + '&code_challenge=' + encodeURIComponent(challenge)
            + '&code_challenge_method=S256';
        if (promptMode) u += '&prompt=' + encodeURIComponent(promptMode);
        return u;
    }

    function parseAuthCallbackSearch(search) {
        const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
        return {
            code: params.get('code') || null,
            error: params.get('error') || null,
            errorDescription: params.get('error_description') || ''
        };
    }

    function acquireCodeSilently(challenge) {
        if (typeof document === 'undefined' || !document.body) {
            return Promise.reject(new Error('当前不在浏览器页面环境'));
        }
        return new Promise(function (resolve, reject) {
            let done = false;
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.setAttribute('aria-hidden', 'true');

            function finish(err, code) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                if (err) reject(err);
                else resolve(code);
            }

            const timer = setTimeout(function () {
                const err = new Error('静默拿取授权超时');
                err.code = 'SILENT_TIMEOUT';
                finish(err);
            }, SILENT_TIMEOUT_MS);

            iframe.addEventListener('load', function () {
                let href = '';
                let search = '';
                try {
                    href = iframe.contentWindow.location.href;
                    search = iframe.contentWindow.location.search;
                } catch (_) {
                    // 跨域页或 X-Frame-Options 拦截说明需要用户交互登录
                    const err = new Error('需要交互登录');
                    err.loginRequired = true;
                    finish(err);
                    return;
                }
                if (href.indexOf('/auth/msa/blank.html') === -1) return;
                const parsed = parseAuthCallbackSearch(search);
                if (parsed.code) {
                    finish(null, parsed.code);
                    return;
                }
                const err = new Error(parsed.errorDescription || parsed.error || '静默授权被拒绝');
                err.code = parsed.error ? String(parsed.error).toUpperCase() : 'SILENT_DENIED';
                err.loginRequired = true;
                finish(err);
            });

            iframe.src = buildAuthorizeUrl(challenge, 'none');
            document.body.appendChild(iframe);
        });
    }

    function acquireCodeViaPopup(challenge) {
        if (typeof window === 'undefined' || typeof window.open !== 'function') {
            return Promise.reject(new Error('当前环境不支持弹窗登录'));
        }
        const url = buildAuthorizeUrl(challenge, null);
        const popup = window.open(url, 'xbox_oauth_popup', 'width=520,height=680');
        if (!popup) {
            const err = new Error('登录弹窗被浏览器拦截，请允许弹窗后重试');
            err.code = 'POPUP_BLOCKED';
            return Promise.reject(err);
        }

        return new Promise(function (resolve, reject) {
            let done = false;
            const started = Date.now();
            const poll = setInterval(function () {
                if (done) return;
                if (state.cancelled) {
                    cleanup();
                    try { popup.close(); } catch (_) { }
                    const err = new Error('已取消登录');
                    err.code = 'CANCELLED';
                    return reject(err);
                }
                if (popup.closed) {
                    cleanup();
                    return reject(new Error('登录窗口已关闭，未完成授权'));
                }
                if (Date.now() - started > 180000) {
                    cleanup();
                    try { popup.close(); } catch (_) { }
                    return reject(new Error('登录超时（3 分钟）'));
                }
                try {
                    const href = popup.location.href;
                    if (href && href.indexOf('/auth/msa/blank.html') !== -1) {
                        const parsed = parseAuthCallbackSearch(popup.location.search);
                        cleanup();
                        try { popup.close(); } catch (_) { }
                        if (parsed.code) return resolve(parsed.code);
                        return reject(new Error(parsed.errorDescription || parsed.error || '登录授权失败'));
                    }
                } catch (_) {
                    // 仍在 login.live.com / login.microsoftonline.com 域，继续等待跳转回同源
                }
            }, 350);

            function cleanup() {
                done = true;
                clearInterval(poll);
            }
        });
    }

    async function exchangeCodeForToken(code, verifier) {
        const r = await httpRequest(TOKEN_URL, {
            method: 'POST',
            retries: 1,
            what: '换取微软访问令牌（PKCE）',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://www.xbox.com'
            },
            data: formEncode({
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: AUTH_REDIRECT_URI,
                code_verifier: verifier
            })
        });
        if (!r.json || !r.json.access_token) {
            throw new Error('换取微软访问令牌失败：未返回 access_token');
        }
        if (r.json.refresh_token) saveRefreshToken(r.json.refresh_token);
        return r.json;
    }

    async function refreshAccessToken(refreshToken) {
        try {
            const r = await httpRequest(TOKEN_URL, {
                method: 'POST',
                retries: 1,
                what: '刷新微软令牌',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://www.xbox.com'
                },
                data: formEncode({
                    client_id: CLIENT_ID,
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    scope: SCOPE
                })
            });
            if (r.json && r.json.access_token) {
                if (r.json.refresh_token) saveRefreshToken(r.json.refresh_token);
                return r.json;
            }
        } catch (err) {
            const j = (err && err.json) || {};
            if (j.error === 'invalid_grant' || err.status === 400) {
                saveRefreshToken('');
                return null;
            }
            throw err;
        }
        return null;
    }

    async function acquireMsaToken() {
        const saved = loadRefreshToken();
        if (saved) {
            ui.log('检测到本地微软授权缓存，正在静默刷新…');
            const refreshed = await refreshAccessToken(saved);
            if (refreshed && refreshed.access_token) {
                return refreshed.access_token;
            }
            ui.log('本地缓存已失效，尝试网页静默拿取…');
        }

        const pkce = await createPkcePair();
        try {
            const code = await acquireCodeSilently(pkce.challenge);
            const tok = await exchangeCodeForToken(code, pkce.verifier);
            return tok.access_token;
        } catch (err) {
            if (err && err.code === 'CANCELLED') throw err;
            ui.log('静默拿取未命中（' + (err.message || '需要登录') + '），弹出微软登录窗口…');
            const code = await acquireCodeViaPopup(pkce.challenge);
            const tok = await exchangeCodeForToken(code, pkce.verifier);
            return tok.access_token;
        }
    }

    async function exchangeXstsTokens(msaAccessToken) {
        const userResp = await httpRequest(USER_AUTH_URL, {
            method: 'POST',
            what: '换取 Xbox User Token',
            headers: {
                'x-xbl-contract-version': '1',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            data: JSON.stringify({
                Properties: {
                    AuthMethod: 'RPS',
                    SiteName: 'user.auth.xboxlive.com',
                    RpsTicket: 'd=' + msaAccessToken
                },
                RelyingParty: 'http://auth.xboxlive.com',
                TokenType: 'JWT'
            })
        });

        const userToken = userResp.json && userResp.json.Token;
        if (!userToken) throw new Error('Xbox User Token 换取失败');

        async function getXsts(rp) {
            const r = await httpRequest(XSTS_URL, {
                method: 'POST',
                what: '换取 XSTS (' + rp + ')',
                headers: {
                    'x-xbl-contract-version': '1',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: JSON.stringify({
                    Properties: {
                        SandboxId: 'RETAIL',
                        UserTokens: [userToken]
                    },
                    RelyingParty: rp,
                    TokenType: 'JWT'
                })
            });
            const data = r.json || {};
            const xui = (data.DisplayClaims && Array.isArray(data.DisplayClaims.xui) && data.DisplayClaims.xui[0]) || {};
            if (!data.Token || !xui.uhs) {
                throw new Error('XSTS (' + rp + ') 缺少 Token 或 uhs');
            }
            return {
                token: data.Token,
                uhs: xui.uhs,
                xuid: xui.xid || null,
                gamertag: xui.gtg || null,
                authHeader: 'XBL3.0 x=' + xui.uhs + ';' + data.Token
            };
        }

        const xbl = await getXsts(RP_XBOXLIVE);
        const mp = await getXsts(RP_MARKETPLACE);
        return { xbl: xbl, mp: mp };
    }

    // ── 微软商店 Collection & 目录解析 ──────────────────────────────────────
    function classifyCollectionItem(item) {
        if (!item || typeof item !== 'object') return 'ignored';
        const pid = String(item.productId || '');
        if (!pid) return 'ignored';
        if (/^CFQ7TTC0/i.test(pid)) return 'ignored';
        if (item.productKind !== 'Game') return 'ignored';
        if (item.status !== 'Active') return 'ignored';
        if (item.isTrial === true || item.skuType === 'Trial') return 'ignored';
        return item.licensingRequired === true ? 'gold' : 'owned';
    }

    async function fetchCollection(mpToken, xuid, market, onProgress) {
        const body = {
            maxPageSize: COLLECTION_PAGE_SIZE,
            excludeDuplicates: true,
            market: market,
            validityType: 'All',
            beneficiaries: [
                {
                    identityType: 'xuid',
                    identityValue: String(xuid),
                    localTicketReference: 'xbox-library-export'
                }
            ]
        };

        const all = [];
        for (let page = 1; page <= COLLECTION_MAX_PAGES; page += 1) {
            const r = await httpRequest(COLLECTIONS_URL, {
                method: 'POST',
                what: '读取微软商店库存第 ' + page + ' 页',
                headers: {
                    'Authorization': mpToken.authHeader,
                    'MS-CV': makeCv(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: JSON.stringify(body)
            });

            const items = (r.json && Array.isArray(r.json.items)) ? r.json.items : null;
            if (!items) throw new Error('collections 接口未返回 items 数组');
            all.push.apply(all, items);
            if (onProgress) onProgress(page, all.length);

            const nextToken = r.json && r.json.continuationToken;
            if (!nextToken || items.length === 0) return all;
            body.continuationToken = nextToken;
        }
        return all;
    }

    async function fetchCatalog(productIds, market, onProgress) {
        const map = new Map();
        const unique = Array.from(new Set(productIds.map(function (id) {
            return String(id || '').toUpperCase();
        }).filter(Boolean)));
        const batches = chunkArray(unique, CATALOG_BATCH);

        for (let i = 0; i < batches.length; i += 1) {
            const url = CATALOG_URL
                + '?bigIds=' + encodeURIComponent(batches[i].join(','))
                + '&market=' + encodeURIComponent(market)
                + '&languages=en-us,neutral';
            const r = await httpRequest(url, {
                method: 'GET',
                what: '读取商店目录第 ' + (i + 1) + '/' + batches.length + ' 批',
                headers: { 'Accept': 'application/json' }
            });
            const products = (r.json && Array.isArray(r.json.Products)) ? r.json.Products : [];
            for (let k = 0; k < products.length; k += 1) {
                const p = products[k];
                if (p && p.ProductId) map.set(String(p.ProductId).toUpperCase(), p);
            }
            if (onProgress) onProgress(i + 1, batches.length);
        }
        return map;
    }

    function extractCatalogPlatforms(product) {
        const out = [];
        function add(p) {
            if (p && out.indexOf(p) === -1) out.push(p);
        }
        const skus = Array.isArray(product && product.DisplaySkuAvailabilities)
            ? product.DisplaySkuAvailabilities : [];
        let hasXpa = false;

        for (let i = 0; i < skus.length; i += 1) {
            const skuProps = skus[i] && skus[i].Sku && skus[i].Sku.Properties;
            if (!skuProps) continue;
            if (skuProps.XboxXPA === true) hasXpa = true;
            const pkgs = Array.isArray(skuProps.Packages) ? skuProps.Packages : [];
            for (let p = 0; p < pkgs.length; p += 1) {
                const deps = Array.isArray(pkgs[p] && pkgs[p].PlatformDependencies)
                    ? pkgs[p].PlatformDependencies : [];
                for (let d = 0; d < deps.length; d += 1) {
                    const name = String((deps[d] && deps[d].PlatformName) || '');
                    if (/^Windows\.(Desktop|Universal)$/i.test(name)) add('Windows');
                    else if (/^Windows\.Xbox$/i.test(name)) add('Xbox');
                }
            }
        }
        if (hasXpa) {
            add('Windows');
            add('Xbox');
        }
        if (!out.length) out.push('Xbox');
        return { platforms: out, isPlayAnywhere: hasXpa };
    }

    function extractPcPackageFamilyName(product) {
        const skus = Array.isArray(product && product.DisplaySkuAvailabilities)
            ? product.DisplaySkuAvailabilities : [];
        let isXpa = false;
        for (let i = 0; i < skus.length; i += 1) {
            const skuProps = skus[i] && skus[i].Sku && skus[i].Sku.Properties;
            if (!skuProps) continue;
            if (skuProps.XboxXPA === true) isXpa = true;
            const pkgs = Array.isArray(skuProps.Packages) ? skuProps.Packages : [];
            for (let p = 0; p < pkgs.length; p += 1) {
                const pkg = pkgs[p];
                if (!pkg || !pkg.PackageFamilyName) continue;
                const deps = Array.isArray(pkg.PlatformDependencies) ? pkg.PlatformDependencies : [];
                for (let d = 0; d < deps.length; d += 1) {
                    if (/^Windows\.(Desktop|Universal)$/i.test(String((deps[d] && deps[d].PlatformName) || ''))) {
                        return String(pkg.PackageFamilyName);
                    }
                }
            }
        }
        if (isXpa && product && product.Properties && product.Properties.PackageFamilyName) {
            return String(product.Properties.PackageFamilyName);
        }
        return null;
    }

    function extractBundledIds(product) {
        const out = [];
        const skus = Array.isArray(product && product.DisplaySkuAvailabilities)
            ? product.DisplaySkuAvailabilities : [];
        for (let i = 0; i < skus.length; i += 1) {
            const skuProps = skus[i] && skus[i].Sku && skus[i].Sku.Properties;
            const bundled = (skuProps && Array.isArray(skuProps.BundledSkus)) ? skuProps.BundledSkus : [];
            for (let b = 0; b < bundled.length; b += 1) {
                const bid = bundled[b] && bundled[b].BigId;
                if (bid) {
                    const up = String(bid).toUpperCase();
                    if (out.indexOf(up) === -1) out.push(up);
                }
            }
        }
        return out;
    }

    function extractCatalogPriceCents(product) {
        const skus = Array.isArray(product && product.DisplaySkuAvailabilities)
            ? product.DisplaySkuAvailabilities : [];
        for (let i = 0; i < skus.length; i += 1) {
            const avails = Array.isArray(skus[i] && skus[i].Availabilities) ? skus[i].Availabilities : [];
            for (let a = 0; a < avails.length; a += 1) {
                const price = avails[a] && avails[a].OrderManagementData && avails[a].OrderManagementData.Price;
                if (price && typeof price.ListPrice === 'number' && Number.isFinite(price.ListPrice)) {
                    if (String(price.CurrencyCode || '').toUpperCase() === 'CNY') {
                        return Math.round(price.ListPrice * 100);
                    }
                }
            }
        }
        return null;
    }

    // ── Xbox Live TitleHub & 游玩时长 ───────────────────────────────────────
    async function fetchTitleHistory(xblToken) {
        const url = TITLEHUB_URL.replace('{xuid}', encodeURIComponent(xblToken.xuid));
        const r = await httpRequest(url, {
            method: 'GET',
            what: '读取 Xbox 游玩历史（titlehub）',
            headers: {
                'Authorization': xblToken.authHeader,
                'x-xbl-contract-version': '2',
                'Accept-Language': 'zh-CN,en-US',
                'Accept': 'application/json'
            }
        });
        return (r.json && Array.isArray(r.json.titles)) ? r.json.titles : [];
    }

    async function fetchMinutesPlayed(xblToken, titleIds) {
        const map = new Map();
        const unique = Array.from(new Set(titleIds.filter(Boolean).map(String)));
        const batches = chunkArray(unique, USERSTATS_BATCH);

        for (let i = 0; i < batches.length; i += 1) {
            const r = await httpRequest(USERSTATS_URL, {
                method: 'POST',
                what: '读取游玩时长（userstats）',
                headers: {
                    'Authorization': xblToken.authHeader,
                    'x-xbl-contract-version': '2',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: JSON.stringify({
                    arrangebyfield: 'xuid',
                    stats: batches[i].map(function (tid) {
                        return { name: 'MinutesPlayed', titleid: tid };
                    }),
                    xuids: [String(xblToken.xuid)]
                })
            });

            const cols = (r.json && Array.isArray(r.json.statlistscollection)) ? r.json.statlistscollection : [];
            const stats = (cols[0] && Array.isArray(cols[0].stats)) ? cols[0].stats : [];
            for (let k = 0; k < stats.length; k += 1) {
                const row = stats[k];
                if (!row || !row.titleid) continue;
                const mins = Number(row.value);
                if (Number.isFinite(mins) && mins >= 0) {
                    map.set(String(row.titleid), Math.round(mins));
                }
            }
        }
        return map;
    }

    function mapTitleDevices(devices) {
        const out = [];
        function add(p) { if (p && out.indexOf(p) === -1) out.push(p); }
        const list = Array.isArray(devices) ? devices : [];
        for (let i = 0; i < list.length; i += 1) {
            const d = String(list[i] || '');
            if (/^(PC|Win32)$/i.test(d)) add('Windows');
            else if (/^Xbox/i.test(d)) add('Xbox');
        }
        if (!out.length) out.push('Xbox');
        return out;
    }

    // ── 主导出流程 ──────────────────────────────────────────────────────────
    async function runExport() {
        const market = PRIMARY_MARKET;

        state.cancelled = false;
        state.startedAt = Date.now();
        state.requests = 0;
        const stages = [];

        ui.progress(5, '获取微软授权');
        const tAuth = Date.now();
        const msaToken = await acquireMsaToken();

        ui.progress(18, '换取 Xbox 令牌');
        const tokens = await exchangeXstsTokens(msaToken);
        stages.push({ name: '鉴权', ms: Date.now() - tAuth });
        ui.log('账号：' + (tokens.xbl.gamertag || tokens.xbl.xuid));

        // 1. 拉取微软商店完整拥有库
        ui.progress(28, '读取已购游戏库');
        const tCol = Date.now();
        const rawCollection = await fetchCollection(tokens.mp, tokens.xbl.xuid, market, function (page, count) {
            ui.progress(28 + Math.min(12, page * 2), '库存第 ' + page + ' 页 (' + count + ' 条)');
        });
        stages.push({ name: '库存', ms: Date.now() - tCol });

        const wanted = new Map();
        let ownedCount = 0;
        let goldCount = 0;
        let ignoredCount = 0;
        for (let i = 0; i < rawCollection.length; i += 1) {
            const item = rawCollection[i];
            const kind = classifyCollectionItem(item);
            if (kind === 'ignored') { ignoredCount += 1; continue; }
            const pid = String(item.productId).toUpperCase();
            if (kind === 'owned') {
                ownedCount += 1;
                wanted.set(pid, { isGold: false, acquiredAt: normalizeIsoDate(item.acquiredDate) });
            } else if (kind === 'gold') {
                goldCount += 1;
                if (!wanted.has(pid)) {
                    wanted.set(pid, { isGold: true, acquiredAt: normalizeIsoDate(item.acquiredDate) });
                }
            }
        }
        ui.log('  商店权益 ' + rawCollection.length + ' 条：已购 ' + ownedCount + ' / 金会员 ' + goldCount + ' / 忽略非游戏 ' + ignoredCount);

        // 2. 拉取商店目录详情（优先 CN 获取人民币价，缺失项自动用 US 兜底）
        let catalog = new Map();
        let catalogErrorCode = null;
        let usFallbackCount = 0;
        if (wanted.size > 0) {
            ui.progress(45, '读取商店目录');
            const tCat = Date.now();
            try {
                catalog = await fetchCatalog(Array.from(wanted.keys()), PRIMARY_MARKET, function (done, total) {
                    ui.progress(45 + Math.round(20 * done / total), '目录 ' + done + '/' + total);
                });
                const missingInPrimary = [];
                wanted.forEach(function (_, pid) {
                    if (!catalog.has(pid)) missingInPrimary.push(pid);
                });
                if (missingInPrimary.length > 0) {
                    const fallbackCat = await fetchCatalog(missingInPrimary, FALLBACK_MARKET);
                    fallbackCat.forEach(function (val, key) {
                        catalog.set(key, val);
                        usFallbackCount += 1;
                    });
                }
                const extraBundleIds = [];
                catalog.forEach(function (prod) {
                    if (!extractPcPackageFamilyName(prod) && extractCatalogPlatforms(prod).platforms.length <= 1) {
                        const bids = extractBundledIds(prod);
                        for (let b = 0; b < bids.length; b += 1) {
                            if (!catalog.has(bids[b]) && extraBundleIds.indexOf(bids[b]) === -1) {
                                extraBundleIds.push(bids[b]);
                            }
                        }
                    }
                });
                if (extraBundleIds.length > 0 && extraBundleIds.length <= 200) {
                    const subCat = await fetchCatalog(extraBundleIds, PRIMARY_MARKET);
                    subCat.forEach(function (val, key) { catalog.set(key, val); });
                }
            } catch (err) {
                catalogErrorCode = errorCodeOf(err);
                ui.log('  ! 商店目录读取失败（将降级）：' + (err.message || String(err)));
            }
            stages.push({ name: '目录', ms: Date.now() - tCat });
        }

        // 3. 拉取 Xbox Live 游玩历史与时长
        ui.progress(75, '读取游玩时长');
        const tPlay = Date.now();
        let playedTitles = [];
        let minutesByTitleId = new Map();
        let playtimeErrorCode = null;
        try {
            playedTitles = await fetchTitleHistory(tokens.xbl);
            const titleIds = playedTitles.map(function (t) { return t && t.titleId; }).filter(Boolean);
            if (titleIds.length > 0) {
                minutesByTitleId = await fetchMinutesPlayed(tokens.xbl, titleIds);
            }
        } catch (err) {
            playtimeErrorCode = errorCodeOf(err);
            ui.log('  ! 游玩时长读取失败（不影响已购库）：' + (err.message || String(err)));
        }
        stages.push({ name: '时长', ms: Date.now() - tPlay });

        const playedByPfn = new Map();
        const playedByTitleKey = new Map();
        for (let i = 0; i < playedTitles.length; i += 1) {
            const t = playedTitles[i];
            if (!t) continue;
            const tid = t.titleId ? String(t.titleId) : null;
            const mins = (tid && minutesByTitleId.has(tid))
                ? minutesByTitleId.get(tid)
                : (t.minutesPlayed != null && Number.isFinite(Number(t.minutesPlayed)) ? Math.round(Number(t.minutesPlayed)) : null);
            const lastPlayed = normalizeIsoDate(t.titleHistory && t.titleHistory.lastTimePlayed);
            const info = {
                titleId: tid,
                pfn: t.pfn ? String(t.pfn) : null,
                rawName: t.name ? String(t.name) : null,
                devices: mapTitleDevices(t.devices),
                playtimeMinutes: mins,
                lastPlayedAt: lastPlayed,
                matched: false
            };
            if (info.pfn) playedByPfn.set(info.pfn.toLowerCase(), info);
            const tk = normalizeTitleKey(info.rawName);
            if (tk && !playedByTitleKey.has(tk)) playedByTitleKey.set(tk, info);
        }

        let excludedExtras = 0;
        let unresolvedCount = 0;
        const games = [];
        const seenTitleKeys = new Set();

        wanted.forEach(function (meta, pid) {
            const prod = catalog.get(pid) || null;
            const localized = prod && Array.isArray(prod.LocalizedProperties) ? prod.LocalizedProperties[0] : null;
            const rawTitle = (localized && localized.ProductTitle) ? String(localized.ProductTitle).trim() : '';

            if (prod && prod.Properties && prod.Properties.IsDemo === true) {
                excludedExtras += 1;
                return;
            }
            if (rawTitle && EXTRA_TITLE_RE.test(rawTitle)) {
                excludedExtras += 1;
                return;
            }

            const cleanName = rawTitle ? cleanDisplayTitle(rawTitle) : '';
            if (!cleanName) unresolvedCount += 1;

            const pfn = prod ? (extractPcPackageFamilyName(prod) || (prod.Properties && prod.Properties.PackageFamilyName) || null) : null;
            const platInfo = prod ? extractCatalogPlatforms(prod) : { platforms: ['Xbox'], isPlayAnywhere: false };
            const priceCents = prod ? extractCatalogPriceCents(prod) : null;

            const tk = normalizeTitleKey(cleanName);
            let playInfo = (pfn && playedByPfn.get(String(pfn).toLowerCase())) || (tk && playedByTitleKey.get(tk)) || null;
            if (playInfo) playInfo.matched = true;
            if (tk) seenTitleKeys.add(tk);

            const entry = {
                name: cleanName || ('未知 Xbox 游戏 (' + pid + ')'),
                productId: pid,
                packageFamilyName: pfn,
                titleId: playInfo ? playInfo.titleId : null,
                platforms: platInfo.platforms,
                isPlayAnywhere: platInfo.isPlayAnywhere,
                isGold: meta.isGold,
                ownershipType: meta.isGold ? 'gold' : 'owned',
                acquiredAt: meta.acquiredAt,
                resolved: !!cleanName
            };
            if (priceCents !== null) entry.priceCents = priceCents;
            if (playInfo && typeof playInfo.playtimeMinutes === 'number') {
                entry.playtimeMinutes = playInfo.playtimeMinutes;
            }
            if (playInfo && playInfo.lastPlayedAt) {
                entry.lastPlayedAt = playInfo.lastPlayedAt;
            }
            games.push(entry);
        });

        games.sort(function (a, b) {
            return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
        });

        let totalPlaytimeMinutes = 0;
        let playtimeGamesCount = 0;
        for (let i = 0; i < games.length; i += 1) {
            if (typeof games[i].playtimeMinutes === 'number' && games[i].playtimeMinutes > 0) {
                playtimeGamesCount += 1;
                totalPlaytimeMinutes += games[i].playtimeMinutes;
            }
        }

        state.result = {
            schemaVersion: SCHEMA_VERSION,
            source: 'xbox-collections-and-titlehub',
            generatedAt: new Date().toISOString(),
            account: {
                xuid: tokens.xbl.xuid,
                gamertag: tokens.xbl.gamertag || null,
                market: usFallbackCount > 0 ? PRIMARY_MARKET + '+' + FALLBACK_MARKET : PRIMARY_MARKET
            },
            summary: {
                gameCount: games.length,
                ownedGamesCount: ownedCount,
                goldGamesCount: goldCount,
                usFallbackCount: usFallbackCount,
                collectionItemsCount: rawCollection.length,
                excludedExtras: excludedExtras,
                unresolvedCount: unresolvedCount,
                playtimeGamesCount: playtimeGamesCount,
                totalPlaytimeMinutes: totalPlaytimeMinutes,
                catalogError: catalogErrorCode,
                playtimeError: playtimeErrorCode
            },
            games: games
        };

        const totalSec = ((Date.now() - state.startedAt) / 1000).toFixed(1);
        ui.progress(100, '完成');
        ui.elapsed(Number(totalSec));
        ui.log('✓ 导出完成：' + games.length + ' 款游戏'
            + (totalPlaytimeMinutes > 0 ? '，总游玩 ' + Math.round(totalPlaytimeMinutes / 60) + ' 小时' : '')
            + '，共 ' + totalSec + 's，请求 ' + state.requests + ' 次');
        ui.log('  分段：' + stages.map(function (x) {
            return x.name + ' ' + (x.ms / 1000).toFixed(1) + 's';
        }).join(' / '));
        enableDownloads(true);
        return state.result;
    }

    // ── 下载与导出 ──────────────────────────────────────────────────────────
    function download(filename, text, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function baseName() {
        const r = state.result;
        const who = (r && r.account && (r.account.gamertag || r.account.xuid))
            ? (r.account.gamertag || r.account.xuid) : 'xbox';
        const day = new Date().toISOString().slice(0, 10);
        return 'xbox-library-' + String(who).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') + '-' + day;
    }

    function exportJson() {
        if (!state.result) return;
        download(baseName() + '.json', JSON.stringify(state.result, null, 2), 'application/json');
    }

    // ── 界面 ────────────────────────────────────────────────────────────────
    const ui = (function () {
        let root, panel, statusEl, elapsedEl, barEl, logEl, btnRun, btnJson, btnReset;

        function inject() {
            root = document.createElement('div');
            root.id = 'xbox-export-root';
            root.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483647;';

            root.innerHTML = ''
                + '<style>'
                + '#xbox-export-root *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}'
                + '#xbox-export-fab{position:fixed;right:18px;bottom:18px;padding:10px 16px;border:0;border-radius:22px;'
                + 'background:#107c10;color:#fff;font-size:13px;font-weight:600;cursor:pointer;'
                + 'box-shadow:0 4px 16px rgba(0,0,0,.35);transition:transform .12s}'
                + '#xbox-export-fab:hover{transform:translateY(-1px)}'
                + '#xbox-export-panel{position:fixed;right:18px;bottom:68px;width:350px;display:none;'
                + 'background:#12161c;color:#e6e9ee;border-radius:12px;padding:16px;'
                + 'box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid #232a33}'
                + '#xbox-export-panel h3{margin:0 0 4px;font-size:15px;font-weight:700}'
                + '#xbox-export-panel .sub{font-size:11px;color:#7d8896;margin-bottom:10px;line-height:1.5}'
                + '.xbox-opt-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;'
                + 'margin-bottom:8px;padding:7px 9px;border-radius:7px;background:#181e27;border:1px solid #252e3a;cursor:pointer;user-select:none}'
                + '.xbox-opt-row input{margin:0;accent-color:#107c10;cursor:pointer}'
                + '#xbox-export-statusrow{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}'
                + '#xbox-export-status{font-size:12px;color:#9aa5b1;flex:1;min-height:16px;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
                + '#xbox-export-elapsed{font-size:12px;color:#5d6875;font-variant-numeric:tabular-nums;min-width:46px;text-align:right}'
                + '#xbox-export-track{height:4px;background:#232a33;border-radius:2px;overflow:hidden;margin-bottom:12px}'
                + '#xbox-export-bar{height:100%;width:0;background:#107c10;transition:width .25s}'
                + '#xbox-export-log{font-size:11px;color:#6f7b89;line-height:1.6;max-height:110px;overflow:auto;'
                + 'margin-bottom:12px;white-space:pre-wrap;word-break:break-all}'
                + '#xbox-export-root button.act{width:100%;padding:9px;border:0;border-radius:7px;'
                + 'font-size:13px;font-weight:600;cursor:pointer;margin-bottom:8px}'
                + '#xbox-export-run{background:#107c10;color:#fff}'
                + '#xbox-export-run:disabled{background:#2a3340;color:#5d6875;cursor:not-allowed}'
                + '#xbox-export-json{width:100%;padding:9px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:#1a212a;color:#cfd6df;font-size:12px;font-weight:600;cursor:pointer}'
                + '#xbox-export-json:disabled{opacity:.35;cursor:not-allowed}'
                + '#xbox-export-reset{width:100%;padding:7px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:transparent;color:#8b96a3;font-size:11px;font-weight:600;cursor:pointer;margin-top:6px}'
                + '</style>'
                + '<button id="xbox-export-fab">Xbox 库存导出</button>'
                + '<div id="xbox-export-panel">'
                + '  <h3>Xbox 库存导出</h3>'
                + '  <div class="sub">免填授权码：自动复用已登录微软会话，导出完整已购库与游玩时长（统一英文名，优先带 CN 人民币定价）。</div>'
                + '  <div id="xbox-export-statusrow">'
                + '    <div id="xbox-export-status">就绪</div>'
                + '    <div id="xbox-export-elapsed"></div>'
                + '  </div>'
                + '  <div id="xbox-export-track"><div id="xbox-export-bar"></div></div>'
                + '  <div id="xbox-export-log"></div>'
                + '  <button id="xbox-export-run" class="act">开始导出</button>'
                + '  <button id="xbox-export-json" disabled>下载 JSON</button>'
                + '  <button id="xbox-export-reset">清除本地授权缓存（切换账号）</button>'
                + '</div>';

            document.body.appendChild(root);

            panel = root.querySelector('#xbox-export-panel');
            statusEl = root.querySelector('#xbox-export-status');
            elapsedEl = root.querySelector('#xbox-export-elapsed');
            barEl = root.querySelector('#xbox-export-bar');
            logEl = root.querySelector('#xbox-export-log');
            btnRun = root.querySelector('#xbox-export-run');
            btnJson = root.querySelector('#xbox-export-json');
            btnReset = root.querySelector('#xbox-export-reset');

            root.querySelector('#xbox-export-fab').addEventListener('click', function () {
                panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
            });
            btnRun.addEventListener('click', function () {
                if (state.running) return;
                state.running = true;
                btnRun.disabled = true;
                startTicker();
                runExport().catch(function (err) {
                    const msg = (err && err.message) ? err.message : String(err);
                    stopTicker();
                    ui.log('✗ 失败：' + msg);
                    ui.progress(0, '失败');
                }).then(function () {
                    state.running = false;
                    btnRun.disabled = false;
                    stopTicker();
                });
            });
            btnJson.addEventListener('click', exportJson);
            if (btnReset) {
                btnReset.addEventListener('click', function () {
                    if (state.running) state.cancelled = true;
                    saveRefreshToken('');
                    ui.log('已清除本地授权缓存，下次导出将重新向网页/弹窗拿取令牌。');
                });
            }

            if (state.result) {
                btnJson.disabled = false;
                statusEl.textContent = '已完成（' + state.result.summary.gameCount + ' 款）';
                barEl.style.width = '100%';
            }
        }

        return {
            mount: inject,
            progress: function (pct, label) {
                if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
                if (statusEl && label) statusEl.textContent = label;
            },
            elapsed: function (sec) {
                if (elapsedEl) elapsedEl.textContent = sec >= 0 ? sec.toFixed(1) + 's' : '';
            },
            log: function (line) {
                if (!logEl) return;
                logEl.textContent = line + '\n' + logEl.textContent;
                logEl.scrollTop = 0;
            },
            setDownloads: function (on) {
                if (btnJson) btnJson.disabled = !on;
            }
        };
    })();

    function enableDownloads(on) { ui.setDownloads(on); }

    function startTicker() {
        stopTicker();
        state.startedAt = Date.now();
        ui.elapsed(0);
        state.ticker = setInterval(function () {
            ui.elapsed((Date.now() - state.startedAt) / 1000);
        }, 100);
    }

    function stopTicker() {
        if (state.ticker) {
            clearInterval(state.ticker);
            state.ticker = null;
        }
    }

    // ── 启动与防 SPA Hydration 清除 ─────────────────────────────────────────
    const REMOUNT_INTERVAL = 1500;
    let remountTimer = null;

    function boot() {
        if (typeof location !== 'undefined' && location.pathname && location.pathname.indexOf('/auth/msa/blank.html') === 0) {
            return;
        }
        if (document.getElementById('xbox-export-root')) return;
        if (!document.body) return;
        ui.mount();
        ui.progress(0, '就绪');
        ui.log('在 www.xbox.com 登录账号后点「开始导出」，全程免填授权码。');
    }

    function bootSafely() {
        try {
            boot();
        } catch (err) {
            console.error('[Xbox 库存导出] 界面挂载失败：', err);
        }
    }

    function watchForRemoval() {
        if (remountTimer) return;
        remountTimer = setInterval(function () {
            if (!document.getElementById('xbox-export-root')) bootSafely();
        }, REMOUNT_INTERVAL);
    }

    if (typeof window !== 'undefined') {
        window.__xboxExport = {
            classifyCollectionItem: classifyCollectionItem,
            extractCatalogPlatforms: extractCatalogPlatforms,
            extractPcPackageFamilyName: extractPcPackageFamilyName,
            cleanDisplayTitle: cleanDisplayTitle,
            normalizeTitleKey: normalizeTitleKey,
            normalizeIsoDate: normalizeIsoDate,
            parseAuthCallbackSearch: parseAuthCallbackSearch,
            runExport: runExport,
            state: state
        };
    }

    if (typeof document === 'undefined') return;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { bootSafely(); watchForRemoval(); }, { once: true });
    } else {
        bootSafely();
        watchForRemoval();
    }
})();
