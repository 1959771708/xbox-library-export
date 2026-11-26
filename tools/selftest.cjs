'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'xbox-library-export.user.js');

let pass = 0;
const failures = [];

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(label + '：期望 ' + e + '，实际 ' + a);
}

async function runCase(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log('✓', name);
    } catch (err) {
        failures.push({ name, err });
        console.error('✗', name, '->', err && err.stack ? err.stack : err);
    }
}

function makeSandbox(options) {
    const opts = options || {};
    const byId = new Map();
    const storageMap = new Map(Object.entries(opts.storage || {}));

    function makeEl(tag) {
        const el = {
            tagName: tag,
            style: {},
            textContent: '',
            innerHTML: '',
            disabled: false,
            checked: false,
            value: '',
            children: [],
            _listeners: {},
            setAttribute: function () {},
            addEventListener: function (type, fn) {
                (this._listeners[type] = this._listeners[type] || []).push(fn);
            },
            appendChild: function (c) { this.children.push(c); return c; },
            remove: function () {},
            click: function () {
                const fns = this._listeners.click || [];
                fns.forEach(function (f) { f.call(el, { target: el }); });
            },
            triggerChange: function (val) {
                this.checked = !!val;
                const fns = this._listeners.change || [];
                fns.forEach(function (f) { f.call(el, { target: el }); });
            }
        };
        let _id = '';
        Object.defineProperty(el, 'id', {
            get: function () { return _id; },
            set: function (v) { _id = v; if (v) byId.set(v, el); },
            configurable: true,
            enumerable: true
        });
        el.querySelector = function (sel) {
            if (sel.charAt(0) !== '#') return null;
            const id = sel.slice(1);
            if (!byId.has(id)) {
                const dummy = makeEl('div');
                dummy.id = id;
            }
            return byId.get(id);
        };
        return el;
    }

    const body = makeEl('body');
    const sandbox = {
        console: console,
        URLSearchParams: URLSearchParams,
        TextEncoder: TextEncoder,
        crypto: require('crypto').webcrypto,
        btoa: function (str) { return Buffer.from(str, 'binary').toString('base64'); },
        Blob: function (parts) { this.parts = parts; },
        URL: { createObjectURL: function () { return 'blob:test'; }, revokeObjectURL: function () {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: function () { return 1; },
        clearInterval: function () {},
        location: { origin: 'https://www.xbox.com', pathname: '/zh-CN/' },
        localStorage: {
            getItem: function (k) { return storageMap.has(k) ? storageMap.get(k) : null; },
            setItem: function (k, v) { storageMap.set(k, String(v)); },
            removeItem: function (k) { storageMap.delete(k); }
        },
        document: {
            readyState: 'complete',
            body: body,
            getElementById: function (id) { return byId.has(id) ? byId.get(id) : null; },
            addEventListener: function () {},
            createElement: function (tag) {
                const el = makeEl(tag);
                if (tag === 'iframe' && typeof opts.onAuthIframe === 'function') {
                    let _src = '';
                    Object.defineProperty(el, 'src', {
                        get: function () { return _src; },
                        set: function (v) {
                            _src = v;
                            setTimeout(function () {
                                const res = opts.onAuthIframe(v);
                                el.contentWindow = { location: { href: res.href, search: res.search || '' } };
                                const fns = el._listeners.load || [];
                                fns.forEach(function (f) { f.call(el); });
                            }, 0);
                        }
                    });
                }
                return el;
            }
        },
        removeChild: function () {},
        GM_xmlhttpRequest: function (cfg) {
            Promise.resolve(opts.onRequest(cfg)).then(function (r) {
                cfg.onload({ status: r.status || 200, responseText: JSON.stringify(r.body) });
            }, function (err) {
                cfg.onerror(err);
            });
        }
    };
    sandbox.window = sandbox;

    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT });
    return {
        api: sandbox.window.__xboxExport,
        byId: byId,
        storageMap: storageMap
    };
}

async function main() {
    await runCase('辅助函数：权益分类 / XPA 与 PC 平台识别 / 标题清洗', async function () {
        const ctx = makeSandbox();
        const api = ctx.api;
        assertEqual(api.classifyCollectionItem({ productId: 'CFQ7TTC0K6L8', productKind: 'Game', status: 'Active' }), 'ignored', '订阅占位符应忽略');
        assertEqual(api.classifyCollectionItem({ productId: '9NBLGGH4NNS1', productKind: 'Game', status: 'Active', licensingRequired: false }), 'owned', '普通已购');
        assertEqual(api.classifyCollectionItem({ productId: '9NBLGGH4NNS2', productKind: 'Game', status: 'Active', licensingRequired: true }), 'gold', '金会员');
        assertEqual(api.cleanDisplayTitle('Forza Horizon 5 (PC)'), 'Forza Horizon 5', '去除后缀');
        assertEqual(api.normalizeIsoDate('1970-01-01T00:00:00.000Z'), null, '哨兵日期清洗');

        const plat = api.extractCatalogPlatforms({
            DisplaySkuAvailabilities: [{
                Sku: {
                    Properties: {
                        XboxXPA: true,
                        Packages: [{ PackageFamilyName: 'Pkg_1', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }]
                    }
                }
            }]
        });
        assertEqual(plat.isPlayAnywhere, true, 'XPA');
        assertEqual(plat.platforms, ['Windows', 'Xbox'], '双平台');
    });

    await runCase('完整导出：已购未玩 + 已购有游玩时长 + 排除未买断仅玩过（XGP/光盘）', async function () {
        const ctx = makeSandbox({
            storage: { xbox_export_refresh_token_v1: 'rt_init' },
            onRequest: function (cfg) {
                const url = cfg.url;
                if (url.includes('oauth2/v2.0/token')) {
                    return { body: { access_token: 'msa_tok', refresh_token: 'rt_next' } };
                }
                if (url.includes('user.auth.xboxlive.com')) {
                    return { body: { Token: 'user_tok' } };
                }
                if (url.includes('xsts.auth.xboxlive.com')) {
                    const req = JSON.parse(cfg.data);
                    return {
                        body: {
                            Token: 'xsts_' + req.RelyingParty,
                            DisplayClaims: { xui: [{ uhs: 'uhs1', xid: '2533274000001', gtg: 'XboxPlayer' }] }
                        }
                    };
                }
                if (url.includes('collections.mp.microsoft.com')) {
                    return {
                        body: {
                            items: [
                                { productId: '9P_OWNED_1', productKind: 'Game', status: 'Active', acquiredDate: '2024-05-01T00:00:00Z' },
                                { productId: '9P_UNPLAYED', productKind: 'Game', status: 'Active', acquiredDate: '2025-01-01T00:00:00Z' },
                                { productId: 'CFQ7TTC0K6L8', productKind: 'Game', status: 'Active' }
                            ]
                        }
                    };
                }
                if (url.includes('displaycatalog.mp.microsoft.com')) {
                    return {
                        body: {
                            Products: [
                                {
                                    ProductId: '9P_OWNED_1',
                                    LocalizedProperties: [{ ProductTitle: '极限竞速：地平线 5 (PC)' }],
                                    DisplaySkuAvailabilities: [{
                                        Sku: { Properties: { XboxXPA: true, Packages: [{ PackageFamilyName: 'Microsoft.ForzaHorizon5_8wekyb3d8bbwe', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }] } },
                                        Availabilities: [{ OrderManagementData: { Price: { CurrencyCode: 'CNY', ListPrice: 248 } } }]
                                    }]
                                },
                                {
                                    ProductId: '9P_UNPLAYED',
                                    LocalizedProperties: [{ ProductTitle: 'Hi-Fi RUSH' }],
                                    DisplaySkuAvailabilities: [{
                                        Sku: { Properties: { XboxXPA: false, Packages: [{ PackageFamilyName: 'Bethesda.HiFiRush_3275kfvn8vcwc', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }] } },
                                        Availabilities: [{ OrderManagementData: { Price: { CurrencyCode: 'CNY', ListPrice: 125 } } }]
                                    }]
                                }
                            ]
                        }
                    };
                }
                if (url.includes('titlehub.xboxlive.com')) {
                    return {
                        body: {
                            titles: [
                                { titleId: '1001', pfn: 'Microsoft.ForzaHorizon5_8wekyb3d8bbwe', name: 'Forza Horizon 5', devices: ['PC', 'XboxSeries'], titleHistory: { lastTimePlayed: '2026-11-20T10:00:00Z' } },
                                { titleId: '1002', pfn: 'Some.XgpGame_123', name: 'Palworld', devices: ['PC'], titleHistory: { lastTimePlayed: '2026-11-18T10:00:00Z' } }
                            ]
                        }
                    };
                }
                if (url.includes('userstats.xboxlive.com')) {
                    return {
                        body: {
                            statlistscollection: [{ stats: [{ titleid: '1001', value: '620' }, { titleid: '1002', value: '180' }] }]
                        }
                    };
                }
                throw new Error('Unexpected URL: ' + url);
            }
        });

        const resDefault = await ctx.api.runExport();
        assertEqual(resDefault.account.gamertag, 'XboxPlayer', 'gamertag');
        assertEqual(resDefault.account.market, 'CN', '默认 CN 市场');
        assertEqual(resDefault.summary.gameCount, 2, '仅导已购 2 款（不含未买断 Palworld）');
        assertEqual(resDefault.summary.totalPlaytimeMinutes, 620, '仅统计已购游戏时长');
        assertEqual(ctx.storageMap.get('xbox_export_refresh_token_v1'), 'rt_next', 'refresh_token 应更新');
    });

    await runCase('免填授权码：无缓存时通过静默 PKCE iframe 拿 code 换令牌', async function () {
        const ctx = makeSandbox({
            onAuthIframe: function (src) {
                assert(src.includes('response_type=code') && src.includes('code_challenge_method=S256'), '应走 PKCE code 流');
                return { href: 'https://www.xbox.com/auth/msa/blank.html?code=pkce_code_123', search: '?code=pkce_code_123' };
            },
            onRequest: function (cfg) {
                const url = cfg.url;
                if (url.includes('oauth2/v2.0/token')) {
                    assert(String(cfg.data).includes('code=pkce_code_123'), '应传回 PKCE code');
                    return { body: { access_token: 'msa_tok_silent', refresh_token: 'rt_silent' } };
                }
                if (url.includes('user.auth.xboxlive.com')) return { body: { Token: 'user_tok' } };
                if (url.includes('xsts.auth.xboxlive.com')) {
                    return { body: { Token: 'xsts_tok', DisplayClaims: { xui: [{ uhs: 'u1', xid: '2533274000002', gtg: 'SilentUser' }] } } };
                }
                if (url.includes('collections.mp.microsoft.com')) return { body: { items: [] } };
                if (url.includes('titlehub.xboxlive.com')) return { body: { titles: [] } };
                throw new Error('Unexpected URL: ' + url);
            }
        });

        const res = await ctx.api.runExport();
        assertEqual(res.account.gamertag, 'SilentUser', '静默拿码应成功登录');
        assertEqual(ctx.storageMap.get('xbox_export_refresh_token_v1'), 'rt_silent', '应缓存新 refresh_token');
    });

    if (failures.length) {
        console.error('\n失败 ' + failures.length + ' 项');
        process.exit(1);
    }
    console.log('\n全部通过：' + pass + ' 项');
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
