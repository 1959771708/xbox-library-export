# Xbox 库存导出

从 **Xbox 官网网页端（`www.xbox.com`）** 导出一份完整的 Xbox / Microsoft Store 游戏库存与游玩时长清单（JSON），包含从未启动过的已购游戏、Xbox Play Anywhere 与金会员（Games with Gold）游戏，供第三方工具导入或做数据分析。

油猴（Tampermonkey）脚本，装一次就行：在 `https://www.xbox.com` 登录微软/Xbox 账号后点右下角按钮，几秒后下载 JSON。

## 一键安装

装好 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）之后，点下面这个链接，浏览器会弹出安装确认页，点「安装」即可：

### 👉 [点此安装 Xbox 库存导出](https://raw.githubusercontent.com/1959771708/xbox-library-export/main/xbox-library-export.user.js)

安装完成后脚本会**自动检查并接收更新**：

```javascript
@updateURL    https://raw.githubusercontent.com/1959771708/xbox-library-export/main/xbox-library-export.user.js
@downloadURL  https://raw.githubusercontent.com/1959771708/xbox-library-export/main/xbox-library-export.user.js
```

---

## 能导出什么

通过同源静默 PKCE iframe（`/auth/msa/blank.html`）或自动弹窗获取微软与 Xbox Live 令牌（**全程免填授权码**），依次调用官方 Collections、DisplayCatalog 与 TitleHub 接口：

- 账号身份（`xuid` / `gamertag` / `market`）
- 完整已购与金会员游戏库（`collections.mp.microsoft.com`）：游戏英文名（统一使用 `languages=en-us,neutral`）、`productId`、`titleId`、`packageFamilyName`、`ownershipType`（`owned` / `gold` / `played_only`）、`isPlayAnywhere`、`isGold`、入库时间 `acquiredAt`、可用平台 `platforms`
- **CN 人民币 / US 美元补全估值**：默认以 `CN` 市场查询国区人民币定价（`priceCents` / `currency: "CNY"`），国区缺失条目自动回退 `US` 市场补全名目与价格
- **游玩时长**：通过 Xbox Live TitleHub 批量拉取 `playtimeMinutes` 与最后游玩时间 `lastPlayedAt`
- **可选「含未买断仅玩过（XGP/光盘）」开关**：
  - 面板提供 **「含未买断仅玩过（XGP/光盘）」** 复选框（默认关闭，仅导买断与金会员库存）；
  - 勾选后会把通过 XGP 或实体光盘玩过但未买断的游戏一并纳入，并标注 `ownershipType: "played_only"`。

**自动过滤**：DLC / 扩展包 / 内购货币等非本体项目，并在 `summary` 中记录排除数量（`excludedExtras`）。

---

## 怎么用

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（电脑和手机端支持油猴的浏览器均可）。
2. 点上面的[一键安装](#一键安装)链接；手动安装可新建脚本并将 [xbox-library-export.user.js](xbox-library-export.user.js) 粘贴保存。
3. 打开 <https://www.xbox.com/> 并登录你的微软/Xbox 账号。
4. 点右下角绿色按钮 **「Xbox 库存导出」**：
   - 如需一并导出仅通过 XGP / 光盘玩过但未买断的游戏，先勾选 **「含未买断仅玩过（XGP/光盘）」**；
   - 点击 **「开始导出」**（若浏览器拦截第三方 Cookie，会自动弹出微软登录窗，登录后自动关闭并继续导出）；
   - 完成后点击 **「下载 JSON」**，保存 `xbox-library-*.json`。
5. 若遇到授权或网络问题，点面板上的 **「环境自检」** 查看分步诊断结果。

---

## 输出格式

```json
{
  "schemaVersion": 1,
  "source": "xbox-collections-and-titlehub",
  "generatedAt": "2026-11-26T11:20:49.341Z",
  "account": {
    "xuid": "2535451184548319",
    "gamertag": "iKun1959771708",
    "market": "CN"
  },
  "summary": {
    "gameCount": 6,
    "ownedGamesCount": 6,
    "goldGamesCount": 0,
    "playedOnlyAdded": 0,
    "includePlayedOnly": false,
    "collectionItemsCount": 39,
    "excludedExtras": 0,
    "unresolvedCount": 0,
    "playtimeGamesCount": 4,
    "totalPlaytimeMinutes": 194,
    "catalogError": null,
    "playtimeError": null
  },
  "games": [
    {
      "name": "DOOM Eternal Standard Edition",
      "productId": "9P5S26314HWQ",
      "titleId": "1857165490",
      "packageFamilyName": "BethesdaSoftworks.DOOMEternal-PC_3275kfvn8vcwc",
      "ownershipType": "owned",
      "isGold": false,
      "isPlayAnywhere": true,
      "platforms": ["Windows", "XboxOne"],
      "acquiredAt": "2024-06-01T12:00:00.000Z",
      "playtimeMinutes": 0,
      "lastPlayedAt": null,
      "priceCents": 15900,
      "currency": "CNY",
      "marketUsed": "CN",
      "resolved": true
    }
  ]
}
```

---

## 本地校验

```bash
npm test
npm run verify
```

---

## 协议

[CC-BY-4.0](LICENSE)
