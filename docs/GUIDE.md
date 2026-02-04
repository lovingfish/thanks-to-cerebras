# 部署指南

## 核心要点

- 服务入口：`deno.ts`
- 配置持久化：Deno KV
- 管理面板：首次访问需设置密码
- 代理鉴权：通过管理面板创建代理密钥动态控制

## 部署流程

### 1. 部署方式

先说结论：现在有 **3 种**部署方式，但我们只“强推 1 种最佳实践”，另外 2 种作为兼容/兜底写清楚即可。

```
你在哪部署？
├─ console.deno.com（新 Deno Deploy，Deno 2）
│  ├─ A. Git 部署（推荐，最省心）
│  └─ B. Playgrounds + bundle（需要额外启用 KV unstable）
└─ dash.deno.com（Deploy Classic，Legacy）
   └─ C. Playground + bundle（老环境通常默认可用）
```

**方式 A：GitHub 绑定部署（推荐）**

1. 打开新 Deno Deploy 控制台：`https://console.deno.com/`
2. 一键 Fork 并部署（推荐）：

   [![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/zhu-jl18/thanks-to-cerebras)

3. 入口文件选择 `deno.ts`，Deploy

> 说明：本仓库根目录包含 `deno.json`，已声明 `"unstable": ["kv"]`，可直接使用 Deno KV。

**方式 B：Playgrounds 部署（新 Deno Deploy / console.deno.com）**

适用：不想 Git 绑定，只想“复制粘贴就跑”。

1. 在 `https://console.deno.com/` 创建一个 Playgrounds 应用
2. 新建/打开入口文件（一般是 `src/main.ts`），粘贴打包单文件内容：
   - `dist/deno.bundle.min.js`（推荐）
   - 或 `dist/deno.bundle.js`（可读版）
3. **在项目根目录新增 `deno.json`**，内容如下（用于启用 KV unstable）：

   ```json
   { "unstable": ["kv"] }
   ```

4. Deploy

> 如果你看到 `TypeError: Deno.openKv is not a function`，就是漏了第 3 步（或 Build Config 没启用 KV）。

**方式 C：Playground 部署（Deploy Classic / dash.deno.com，Legacy）**

适用：老项目还在 Classic 上跑，暂时不迁移。

1. 在 `https://dash.deno.com/` 点击 "New Playground"
2. 打开打包好的单文件：
   [`dist/deno.bundle.min.js`](https://github.com/zhu-jl18/thanks-to-cerebras/blob/bundle/dist/deno.bundle.min.js)
3. 全选复制并粘贴到 Playground（Classic 通常默认可用 KV），保存并 Deploy

> 说明：Deno 官方在推进从 Deploy Classic 迁移到新 Deno Deploy。建议新部署优先用方式 A/B。

### 2. （可选）调整 KV 刷盘间隔

默认每 15 秒刷盘一次（最小
1000ms）。部署后登录管理面板，在「访问控制」→「高级设置」里调整。

### 3. 验证部署

访问日志，应看到：

```
Cerebras Proxy 启动
- 管理面板: /
- API 代理: /v1/chat/completions
- 模型接口: /v1/models
- 存储: Deno KV
```

### 4. 首次配置

1. 浏览器打开 `https://<project>.deno.dev/`
2. 设置管理密码（至少 4 位）
3. 登录后添加 Cerebras API 密钥
4. （可选）创建代理访问密钥

## 运维说明

### 管理面板

- 首次访问必须设置密码
- 登录会话有效期 7 天（过期后需重新输入密码，管理密码本身永久有效）
- 三个标签页：访问控制、API 密钥、模型配置

### 访问控制

- 无代理密钥时：公开访问
- 有代理密钥时：需 Bearer token 鉴权
- 最多 5 个代理密钥

### 模型下架处理（model_not_found）

当模型在上游被下架/不可用时，上游可能返回 `404 model_not_found`，导致请求失败。

本服务会在代理热路径做清理与重试：

- 发现 `model_not_found` 会把该模型从模型池中移除（持久化到 KV），并立刻切换到下一个模型继续重试（最多 3 次）
- 你可以在管理面板「模型配置」里重新勾选/保存模型池；也可以点击“刷新”更新模型目录

### 统计刷盘

默认每 15 秒将统计数据异步写回 KV，最终一致。

- 推荐在管理面板「访问控制」→「高级设置」里调整刷盘间隔。
- 刷盘间隔会被钳制到 **最小 1000ms**（例如设置成 `0` 或 `500` 最终都会按
  `1000ms` 执行）。

## 客户端配置

```
API Base: https://<project>.deno.dev/v1
API Key: <代理密钥> 或任意（未启用鉴权时）
Model: 任意
```

## 常见问题

**"没有可用的 API 密钥"** 至少保留一个状态为 active 的 Cerebras API 密钥。

**`TypeError: Deno.openKv is not a function`**

- 新 Deno Deploy（`console.deno.com`）下，Deno KV 仍为 unstable：需要在根目录提供 `deno.json`（`{ "unstable": ["kv"] }`）或在 Build Config 启用 KV/unstable。

**401 Unauthorized** 检查是否创建了代理密钥，客户端是否携带正确的 Bearer token。

**统计数据跳变** 多实例部署时各实例不共享内存缓存，统计受刷盘间隔影响。
