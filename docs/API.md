# API 文档

> 📖 相关文档：[README](../README.md) | [部署指南](GUIDE.md) | [技术细节](TECH_DETAILS.md)

## 0. 约定

- Base URL：`https://<your-project>.deno.dev`
- 所有接口默认支持 CORS。
- `OPTIONS` 预检请求统一返回 `204`。
- JSON 响应默认带 `Cache-Control: no-store`（用于避免缓存敏感数据/统计）。

> 管理 API（`/api/*`）的非 2xx 错误采用 Problem Details：
>
> - `Content-Type: application/problem+json`
> - Body: `{ type, title, status, detail, instance? }`

## 1. 鉴权模型

### 1.1 管理面板 / 管理 API

- Header：`X-Admin-Token: <token>`
- token 获取方式见 `/api/auth/login` / `/api/auth/setup`

### 1.2 代理 API（OpenAI 兼容入口）

- 当 **未创建任何代理密钥**（`/api/proxy-keys` 为空）时：**公开访问**。
- 当 **已创建代理密钥** 时：必须携带
  - Header：`Authorization: Bearer <proxy_key>`

## 2. OpenAI 兼容代理接口（对外）

### 2.1 `GET /v1/models`

- 描述：返回对外暴露的“虚拟模型”列表。
- 响应：OpenAI 风格的 `list`。

### 2.2 `POST /v1/chat/completions`

- 描述：将 OpenAI 风格的 Chat Completions 请求代理到 Cerebras。
- 行为：
  - 会把请求体的 `model` 字段覆盖为模型池轮询得到的真实模型
  - 流式响应会直接透传上游 response body
  - 若上游返回 `404` 且错误为 `model_not_found`，代理会把该模型从模型池中移除（持久化到 KV），并立刻切换到下一个模型重试（最多 `3` 次）

常见响应码：

- `401`：代理访问未授权（启用了代理密钥但没带/带错 Bearer token）
- `429`：当前没有可用 API key（全部处于冷却/不可用等）

## 3. 管理鉴权 API（无需先登录）

### 3.1 `GET /api/auth/status`

- Header（可选）：`X-Admin-Token`
- 响应：
  - `hasPassword: boolean`：是否已设置管理密码
  - `isLoggedIn: boolean`：token 是否有效

### 3.2 `POST /api/auth/setup`

- 描述：首次设置管理密码（只能调用一次；已设置则返回错误）。
- 请求体：`{ "password": string }`
- 响应：`{ "success": true, "token": string }`

### 3.3 `POST /api/auth/login`

- 请求体：`{ "password": string }`
- 响应：`{ "success": true, "token": string }`

### 3.4 `POST /api/auth/logout`

- Header：`X-Admin-Token`
- 响应：`{ "success": true }`

## 4. 管理 API（需要登录）

> 以下接口都需要 Header：`X-Admin-Token`

### 4.1 代理访问密钥（Proxy Keys）

- `GET /api/proxy-keys`
  - 返回：密钥列表（key 会做 mask）、`maxKeys`、`authEnabled`
- `POST /api/proxy-keys`
  - 请求体：`{ "name": string }`（可选）
  - 成功：返回新创建的密钥（返回体中会包含一次性明文 key）
- `DELETE /api/proxy-keys/<id>`
- `GET /api/proxy-keys/<id>/export`
  - 返回明文 key（用于复制给客户端）

### 4.2 Cerebras API 密钥（API Keys）

- `GET /api/keys`
  - 返回：key 列表（key 会做 mask）
- `POST /api/keys`
  - 请求体：`{ "key": string }`
- `POST /api/keys/batch`
  - Content-Type 支持：`application/json` 或纯文本
  - 返回：导入结果汇总（部分成功/失败）
- `DELETE /api/keys/<id>`
- `POST /api/keys/<id>/test`
  - 描述：测活单个 key（会访问上游）
  - 注意：该操作会更新 KV 内该 key 的 `status`
- `GET /api/keys/export`
  - 导出全部明文 key
- `GET /api/keys/<id>/export`
  - 导出单个明文 key

### 4.3 模型池（Models）

模型目录（Catalog）：

- `GET /api/models/catalog`
  - 描述：从 Cerebras public models API 拉取并缓存“可用模型列表”。
  - 返回：`models`、`fetchedAt`、`ttlMs`、`stale`、`lastError?`
- `POST /api/models/catalog/refresh`
  - 描述：强制刷新模型目录。

模型池（Pool）：

- `GET /api/models`
  - 返回：
    - `models: string[]`：配置的模型池
- `PUT /api/models`
  - 描述：一次性更新模型池（会去重/trim）。
  - 请求体：`{ "models": string[] }`
- `POST /api/models/<name>/test`
  - 描述：用当前某个 active key 对指定模型做一次上游请求

### 4.4 统计与配置

- `GET /api/stats`
- `GET /api/config`
  - 返回配置（包含 KV 刷盘相关字段：`kvFlushIntervalMs` /
    `effectiveKvFlushIntervalMs` / `kvFlushIntervalMinMs`）
- `PATCH /api/config`
  - 请求体：`{ "kvFlushIntervalMs": number }`
  - 用途：更新 KV 刷盘间隔（会被钳制到最小值）
