# 留言地图功能设计文档

**日期**: 2026-05-18  
**状态**: 已确认

---

## 概述

在现有单页网站中新增「留言地图」功能：用户提交留言后，系统通过 IP 自动获取地理位置（省/市），留言在 ECharts 中国地图上以橙色光效点亮对应城市。同时提供简易密码保护的后台管理视图，展示全量统计数据。

## 技术栈

- **数据库**: Neon (serverless Postgres)，免费层
- **API**: Vercel Serverless Functions，2 个接口
- **地图**: ECharts + 中国地图 GeoJSON（省份级，城市以散点覆盖）
- **IP 定位**: ip-api.com 免费 API（45 req/min，在 Vercel Function 中调用）
- **前端**: 现有 index.html 内联改造，零额外依赖

## 数据库设计

单表 `comments`：

| 列 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PRIMARY KEY | 自增主键 |
| nickname | VARCHAR(50) NOT NULL | 用户昵称 |
| content | TEXT NOT NULL | 留言内容（最长 500 字） |
| province | VARCHAR(50) | 省份 |
| city | VARCHAR(50) | 城市 |
| country | VARCHAR(50) DEFAULT '中国' | 国家 |
| created_at | TIMESTAMPTZ DEFAULT NOW() | 创建时间 |

## API 设计

### `POST /api/comments`

接收留言并自动获取地理位置。

- **Request body**: `{ nickname: string, content: string }`
- **定位逻辑**: 从 `x-forwarded-for` 取 IP → 调用 `http://ip-api.com/json/{ip}?lang=zh-CN` → 解析 `regionName`(省) 和 `city`(市)
- **校验**: nickname 1-20 字符，content 1-500 字符，服务端裁剪
- **写入**: INSERT INTO comments
- **Response**: `{ ok: true, comment: { id, nickname, content, province, city, created_at } }`

### `GET /api/comments`

返回留言列表，供前端渲染地图和留言列表。

- **Query params**: `limit=50`（分页暂不做）
- **Response**: `{ comments: [{ id, nickname, content, province, city, country, created_at }] }`

### `GET /api/comments?admin=true&password=xxx`

后台统计接口。

- **校验**: password 与 Vercel 环境变量 `ADMIN_PASSWORD` 比对
- **Response**: `{ total: N, cities: N, provinces: [{name, count}], comments: [...] }`

## 前端改造

### 导航调整

将现有「Media Feed」导航项（空壳占位）更名为「留言地图」，图标使用地图/marker 风格 SVG。

### 新视图 `view-guest-map`

布局：桌面端左右两栏，移动端上下堆叠。

- **左栏（60%）**：ECharts 中国地图容器
  - 深色底 `#1a1a2e`（暗色模式）/ 浅底 `#f8f5f0`（亮色模式）
  - 加载中国 GeoJSON，省份描边
  - 有留言的城市渲染橙色散点（`scatter` series），带涟漪动画
  - 散点颜色 `#d97757`（`--accent-claude`）
  - 城市累计留言越多，散点越大
- **右栏（40%）**：
  - **留言表单**：昵称输入 + 留言 textarea + 提交按钮（按钮使用 `try-btn` 相同风格）
  - **留言列表**：滚动容器，每条显示昵称、时间、城市标签、内容

### 暗色/亮色模式适配

ECharts 在 `toggleTheme()` 时重新 `setOption` 切换浅/深配色。

### 后台管理页

通过 URL hash `#admin` 进入，提示输入密码。验证通过后展示：
- 统计数据卡片（总留言数、点亮城市数、覆盖省份数）
- 同样的 ECharts 地图（全量数据）
- 中国省份榜单

密码通过 Vercel 环境变量 `ADMIN_PASSWORD` 配置，前端不硬编码。

## 部署

1. `vercel link` 关联项目
2. `vercel env add ADMIN_PASSWORD` 设置管理密码
3. `vercel --prod` 部署
4. Neon 连接字符串同样存为 Vercel 环境变量 `DATABASE_URL`

## 非功能需求

- **安全**: API 做输入校验和裁剪，防 SQL 注入（参数化查询），防 XSS（前端渲染时 escape）
- **性能**: 首次加载获取全部留言（预期 < 1000 条），GeoJSON 数据约 500KB（gzip 后 ~100KB）
- **容错**: IP 定位失败时 province/city 留空，留言仍正常写入，地图上不显示散点
- **速率限制**: 同一 IP 60 秒内最多提交 3 条留言（Vercel Function 内存 Map 实现）

## 占位预留

- Media Feed 功能区域可在此后改回或独立成新视图
- 留言列表目前不分页（数据量小），代码中 `limit` 参数已预留分页扩展
- 地图目前仅显示中国，海外访客 IP 坐标单独存储 `country != '中国'`，后续可扩展世界地图
