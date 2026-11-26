# Xbox 库存导出

从 **Xbox 官网网页端（`www.xbox.com`）** 导出账号的完整游戏库存与游玩时长（JSON），包含从未启动过的已购游戏、Xbox Play Anywhere 与金会员游戏。

## 怎么用

1. 安装 **Tampermonkey（篡改猴）**，新建脚本并粘贴 [xbox-library-export.user.js](xbox-library-export.user.js) 保存（或通过仓库 Raw 链接一键安装）。
2. 打开 <https://www.xbox.com/> 并登录你的微软/Xbox 账号，点右下角绿色按钮 **「Xbox 库存导出」**。
3. 可选勾选 **「含未买断仅玩过（XGP/光盘）」**（脚本会自动优先查 `CN` 区获取人民币定价并统一英文名，缺失条目自动用 `US` 区补全）。
4. 点 **「开始导出」**（**全程免填授权码**）：
   - 脚本会自动通过同源静默 PKCE iframe 拿取微软令牌；若浏览器拦截第三方 Cookie，会自动弹出微软登录窗，登录后自动关闭并继续导出；
   - 完成后点 **「下载 JSON」**，得到 `xbox-library-*.json`。

## 本地校验

```bash
npm test
npm run verify
```
