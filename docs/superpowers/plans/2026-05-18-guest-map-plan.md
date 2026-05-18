# 留言地图功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有单页网站中新增留言地图功能 —— 用户留言后通过 IP 自动获取地理位置，以 ECharts 中国地图橙色散点可视化点亮对应城市，提供密码保护的后台管理视图。

**Architecture:** Vercel Serverless Function (`api/comments.js`) 作为 API 网关，处理 GET/POST 请求，连接 Neon Postgres 数据库。前端 index.html 新增 `view-guest-map` 视图，通过 ECharts CDN + 阿里云 DataV 中国 GeoJSON 渲染地图，配合留言表单和列表。

**Tech Stack:** Neon (Postgres), Vercel Serverless Functions, `@neondatabase/serverless` driver, ECharts 5.4.3 CDN, 阿里云 DataV GeoJSON, ip-api.com 免费 IP 定位

---

## File Structure

```
项目根目录/
├── api/
│   ├── comments.js          # Vercel Function: GET/POST /api/comments
│   └── package.json          # @neondatabase/serverless 依赖
├── index.html                # 修改: 导航 + 新视图 + JS
├── vercel.json               # 新建: 路由配置
├── .env.example              # 新建: 本地开发环境变量说明
└── schema.sql                # 新建: Neon 建表语句（文档记录用）
```

---

### Task 1: 数据库建表 (Neon)

**Files:**
- Create: `schema.sql`

- [ ] **Step 1: 在 Neon Console 创建项目**

去 [neon.tech](https://neon.tech) 创建免费项目，获取连接字符串（格式：`postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`），记下来后续用作 `DATABASE_URL`。

- [ ] **Step 2: 执行建表 SQL**

在 Neon Console 的 SQL Editor 中执行：

```sql
CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    province VARCHAR(50),
    city VARCHAR(50),
    country VARCHAR(50) DEFAULT '中国',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 3: 保存建表语句到项目**

`schema.sql`:

```sql
-- Neon Postgres: 留言地图功能建表
-- 在 Neon SQL Editor 中执行此文件内容

CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    province VARCHAR(50),
    city VARCHAR(50),
    country VARCHAR(50) DEFAULT '中国',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 4: 提交**

```bash
git add schema.sql
git commit -m "feat: add comments table schema for guest map"
```

---

### Task 2: Vercel API 层（api/comments.js）

**Files:**
- Create: `api/package.json`
- Create: `api/comments.js`
- Create: `.env.example`

- [ ] **Step 1: 创建 `api/package.json`**

```json
{
  "name": "guest-map-api",
  "dependencies": {
    "@neondatabase/serverless": "^0.9.0"
  }
}
```

- [ ] **Step 2: 创建 `.env.example`**

```
# Vercel 环境变量（通过 vercel env add 设置，不要提交到 git）
DATABASE_URL=postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require
ADMIN_PASSWORD=your-admin-password
```

- [ ] **Step 3: 创建 `api/comments.js`**

```javascript
const { neon } = require('@neondatabase/serverless');

// 速率限制: IP → { count, resetAt }
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 秒

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return true;
    }
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
}

async function getGeoLocation(ip) {
    // 本地/内网 IP 跳过定位
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return { province: null, city: null, country: '中国' };
    }
    try {
        const res = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`);
        if (!res.ok) return { province: null, city: null, country: '中国' };
        const data = await res.json();
        if (data.status !== 'success') return { province: null, city: null, country: '中国' };
        return {
            province: data.regionName || null,
            city: data.city || null,
            country: data.country || '中国'
        };
    } catch {
        return { province: null, city: null, country: '中国' };
    }
}

function sanitize(str, maxLen) {
    return String(str || '').trim().slice(0, maxLen).replace(/[<>]/g, '');
}

module.exports = async function handler(req, res) {
    const sql = neon(process.env.DATABASE_URL);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    // --- GET: 查询留言 ---
    if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const admin = url.searchParams.get('admin');
        const password = url.searchParams.get('password');

        try {
            if (admin === 'true') {
                if (!password || password !== process.env.ADMIN_PASSWORD) {
                    return res.status(403).json({ error: '密码错误' });
                }
                const rows = await sql`SELECT * FROM comments ORDER BY created_at DESC`;
                const cities = new Set(rows.filter(r => r.city).map(r => `${r.province}-${r.city}`));
                const provinceCounts = {};
                rows.filter(r => r.province).forEach(r => {
                    provinceCounts[r.province] = (provinceCounts[r.province] || 0) + 1;
                });
                return res.status(200).json({
                    total: rows.length,
                    cities: cities.size,
                    provinces: Object.entries(provinceCounts).map(([name, count]) => ({ name, count })),
                    comments: rows
                });
            }

            const rows = await sql`SELECT id, nickname, content, province, city, country, created_at FROM comments ORDER BY created_at DESC LIMIT 100`;
            return res.status(200).json({ comments: rows });
        } catch (err) {
            return res.status(500).json({ error: '数据库查询失败' });
        }
    }

    // --- POST: 提交留言 ---
    if (req.method === 'POST') {
        const ip = getClientIP(req);

        if (!checkRateLimit(ip)) {
            return res.status(429).json({ error: '提交太频繁，请 60 秒后再试' });
        }

        let body = '';
        try {
            body = await new Promise((resolve, reject) => {
                let data = '';
                req.on('data', chunk => { data += chunk; if (data.length > 1024) reject(new Error('too large')); });
                req.on('end', () => resolve(data));
                req.on('error', reject);
            });
        } catch {
            return res.status(413).json({ error: '请求体过大' });
        }

        let parsed;
        try { parsed = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON 格式错误' }); }

        const nickname = sanitize(parsed.nickname, 20);
        const content = sanitize(parsed.content, 500);

        if (!nickname || !content) {
            return res.status(400).json({ error: '昵称和留言不能为空' });
        }

        const geo = await getGeoLocation(ip);

        try {
            const rows = await sql`
                INSERT INTO comments (nickname, content, province, city, country)
                VALUES (${nickname}, ${content}, ${geo.province}, ${geo.city}, ${geo.country})
                RETURNING id, nickname, content, province, city, country, created_at
            `;
            return res.status(201).json({ ok: true, comment: rows[0] });
        } catch (err) {
            return res.status(500).json({ error: '留言提交失败' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
```

- [ ] **Step 4: 提交**

```bash
git add api/ .env.example
git commit -m "feat: add Vercel serverless API for guest map comments"
```

---

### Task 3: 前端 — 导航栏修改

**Files:**
- Modify: `index.html:511-514`（导航 HTML）
- Modify: `index.html:796`（pagesConfig JS）

- [ ] **Step 1: 替换 Media Feed 导航项为「留言地图」**

将左侧导航中 Media Feed 的 `<li>` 替换：

旧代码（约 511-514 行）:
```html
<li class="nav-item" id="nav-media-feed" onclick="switchTab('media-feed')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
    <span>Media Feed</span>
</li>
```

改为:
```html
<li class="nav-item" id="nav-guest-map" onclick="switchTab('guest-map')">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    <span>留言地图</span>
</li>
```

- [ ] **Step 2: 更新 pagesConfig**

在 `pagesConfig` 中将 `media-feed` 替换为 `guest-map`：

```javascript
'guest-map': { breadcrumb: 'Pages / Guest Map', title: '留言地图' },
```

同时删除旧行 `'media-feed': { breadcrumb: 'Pages / Media Feed', title: '内容矩阵' },`

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: replace Media Feed nav with guest map nav"
```

---

### Task 4: 前端 — 留言地图视图 HTML + CSS

**Files:**
- Modify: `index.html` — 在 `view-media-feed` 位置替换为新视图 HTML
- Modify: `index.html` — `<style>` 块中新增 CSS

- [ ] **Step 1: 替换视图 HTML**

将 `view-media-feed` 的 div（约 771-774 行）替换为 `view-guest-map`：

```html
<!-- 视图 6：留言地图 -->
<div id="view-guest-map" class="content-wrapper view-section">
    <div class="guest-map-layout">
        <div class="map-panel">
            <div id="china-map" class="map-container"></div>
        </div>
        <div class="comment-panel">
            <div class="comment-form-block">
                <h4 class="comment-form-title">留下足迹</h4>
                <input type="text" id="cmt-nickname" class="comment-input" placeholder="你的昵称" maxlength="20" autocomplete="off">
                <textarea id="cmt-content" class="comment-textarea" placeholder="说点什么..." maxlength="500" rows="3"></textarea>
                <button id="cmt-submit" class="try-btn submit-btn" onclick="submitComment()">
                    点亮地图 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>
                </button>
                <p id="cmt-error" class="comment-error" style="display:none"></p>
                <p id="cmt-success" class="comment-success" style="display:none">留言成功！你的城市在地图上点亮了 ✨</p>
            </div>
            <div class="comment-list" id="comment-list">
                <p class="comment-empty">暂无留言，成为第一个点亮地图的人吧！</p>
            </div>
        </div>
    </div>
</div>
```

- [ ] **Step 2: 在 `<style>` 块末尾（`</style>` 前，约 488 行）新增 CSS**

```css
/* =========================================
   视图 6: 留言地图
   ========================================= */
.guest-map-layout { display: flex; gap: 1.5rem; min-height: 500px; }
.map-panel { flex: 0 0 60%; background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; }
.map-container { width: 100%; height: 100%; min-height: 500px; }
.comment-panel { flex: 1; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }

.comment-form-block {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 20px; padding: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;
}
.comment-form-title { font-size: 1rem; font-weight: 800; color: var(--text-primary); }
.comment-input, .comment-textarea {
    width: 100%; padding: 0.7rem 1rem; border-radius: 12px; border: 1px solid var(--border);
    background: var(--bg-main); color: var(--text-primary); font-size: 0.9rem;
    font-family: inherit; resize: vertical; outline: none; transition: var(--transition);
}
.comment-input:focus, .comment-textarea:focus { border-color: var(--accent-claude); }
.submit-btn { align-self: flex-end; }
.comment-error { color: #e74c3c; font-size: 0.8rem; font-weight: 600; }
.comment-success { color: #27ae60; font-size: 0.8rem; font-weight: 600; }

.comment-list {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 20px; padding: 1.5rem; flex: 1; overflow-y: auto; max-height: 400px;
    display: flex; flex-direction: column; gap: 1rem;
}
.comment-empty { color: var(--text-placeholder); font-size: 0.9rem; text-align: center; padding: 2rem 0; }

.comment-item { padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
.comment-item:last-child { border-bottom: none; padding-bottom: 0; }
.comment-item-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
.comment-item-nickname { font-weight: 800; font-size: 0.9rem; color: var(--text-primary); }
.comment-item-location {
    font-size: 0.7rem; background: rgba(217,119,87,0.1); color: var(--accent-claude);
    padding: 2px 8px; border-radius: 6px; font-weight: 700;
}
.comment-item-time { font-size: 0.7rem; color: var(--text-placeholder); margin-left: auto; }
.comment-item-content { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5; }

/* 后台管理页 */
.admin-section { display: none; }
.admin-section.active { display: flex; flex-direction: column; gap: 1.5rem; }
.admin-auth { display: flex; gap: 0.5rem; align-items: center; }
.admin-auth input {
    padding: 0.6rem 1rem; border-radius: 12px; border: 1px solid var(--border);
    background: var(--bg-main); color: var(--text-primary); font-size: 0.9rem; outline: none;
}
.admin-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.admin-stat-card {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px;
    padding: 1.5rem; text-align: center;
}
.admin-stat-num { font-size: 2rem; font-weight: 900; color: var(--accent-claude); }
.admin-stat-label { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem; }
.admin-province-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.admin-province-tag {
    font-size: 0.8rem; background: var(--bg-block); color: var(--text-on-block);
    padding: 0.3rem 0.8rem; border-radius: 8px; font-weight: 600;
}

/* 留言地图响应式 */
@media (max-width: 768px) {
    .guest-map-layout { flex-direction: column; }
    .map-panel { flex: 0 0 auto; }
    .map-container { min-height: 350px; }
    .comment-list { max-height: 300px; }
    .admin-stats { grid-template-columns: 1fr; }
}
```

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: add guest map view HTML structure and CSS"
```

---

### Task 5: 前端 — ECharts 地图渲染 JS

**Files:**
- Modify: `index.html` — 在 `<script>` 末尾（`</script>` 前）新增 JS

- [ ] **Step 1: 引入 ECharts CDN**

在 `<head>` 末尾（`</head>` 前，约 489 行）添加：

```html
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
```

- [ ] **Step 2: 新增 ECharts 地图渲染逻辑**

在 `<script>` 块末尾（`</script>` 前，约 1150 行）新增以下代码。分 3 个子函数：

**2a. 加载中国 GeoJSON 并注册地图：**

```javascript
// --- 留言地图核心 ---
let chinaMapRegistered = false;
let mapChart = null;

async function ensureChinaMap() {
    if (chinaMapRegistered) return;
    const res = await fetch('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json');
    const geoJson = await res.json();
    echarts.registerMap('china', geoJson);
    chinaMapRegistered = true;
}
```

**2b. 渲染地图（支持亮色/暗色模式）：**

```javascript
function renderMapChart(comments) {
    const dom = document.getElementById('china-map');
    if (!dom) return;

    if (!mapChart) {
        mapChart = echarts.init(dom);
        window.addEventListener('resize', () => mapChart && mapChart.resize());
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDark ? '#1a1919' : '#fefcf5';
    const textColor = isDark ? '#a0a0a0' : '#4a4a4a';
    const borderColor = isDark ? '#3a3a3a' : '#ddd';
    const scatterColor = '#d97757';

    // 聚合城市留言计数
    const cityCount = {};
    comments.forEach(c => {
        if (!c.city) return;
        const key = `${c.province || ''}-${c.city}`;
        cityCount[key] = (cityCount[key] || 0) + 1;
    });

    const scatterData = Object.entries(cityCount).map(([key, count]) => {
        const [province, city] = key.split('-');
        return { name: city, value: [...getCityCoord(city, province), count] };
    });

    const option = {
        backgroundColor: bgColor,
        tooltip: {
            trigger: 'item',
            formatter: function(p) {
                if (p.seriesType === 'scatter') return `${p.name}: ${p.value[2]} 条留言`;
                return p.name;
            }
        },
        geo: {
            map: 'china',
            roam: false,
            zoom: 1.2,
            center: [104, 35],
            itemStyle: {
                areaColor: isDark ? '#2d2b2b' : '#f0ede5',
                borderColor: borderColor,
                borderWidth: 0.5
            },
            emphasis: {
                itemStyle: { areaColor: isDark ? '#3d3b3b' : '#e0dcd0' },
                label: { show: false }
            },
            label: { show: false }
        },
        series: [{
            type: 'scatter',
            coordinateSystem: 'geo',
            data: scatterData,
            symbolSize: function(val) { return Math.min(8 + val[2] * 4, 40); },
            itemStyle: {
                color: scatterColor,
                shadowBlur: 10,
                shadowColor: scatterColor
            },
            emphasis: {
                scale: 1.5,
                itemStyle: { shadowBlur: 20 }
            },
            rippleEffect: { brushType: 'stroke', scale: 3 },
            encode: { value: 2 }
        }]
    };

    mapChart.setOption(option, true);
}
```

**2c. 城市名 → 坐标映射（核心映射表，覆盖主要城市）：**

```javascript
function getCityCoord(city, province) {
    const map = {
        '北京': [116.46, 39.92], '上海': [121.48, 31.22], '广州': [113.23, 23.16],
        '深圳': [114.07, 22.62], '杭州': [120.19, 30.26], '南京': [118.78, 32.04],
        '成都': [104.06, 30.67], '武汉': [114.31, 30.52], '重庆': [106.54, 29.59],
        '西安': [108.95, 34.27], '长沙': [112.98, 28.19], '郑州': [113.65, 34.76],
        '济南': [117.00, 36.65], '青岛': [120.38, 36.07], '天津': [117.20, 39.13],
        '苏州': [120.62, 31.32], '合肥': [117.27, 31.86], '福州': [119.30, 26.08],
        '厦门': [118.10, 24.46], '沈阳': [123.38, 41.80], '大连': [121.62, 38.92],
        '哈尔滨': [126.63, 45.75], '长春': [125.35, 43.88], '昆明': [102.73, 25.04],
        '贵阳': [106.71, 26.57], '南宁': [108.33, 22.84], '海口': [110.35, 20.02],
        '石家庄': [114.48, 38.03], '太原': [112.53, 37.87], '呼和浩特': [111.65, 40.82],
        '兰州': [103.73, 36.03], '西宁': [101.74, 36.56], '银川': [106.27, 38.47],
        '乌鲁木齐': [87.68, 43.77], '拉萨': [91.11, 29.97], '南昌': [115.89, 28.68],
        '宁波': [121.54, 29.86], '无锡': [120.29, 31.59], '东莞': [113.75, 23.04],
        '佛山': [113.12, 23.02], '温州': [120.70, 28.00], '珠海': [113.58, 22.27],
        '常州': [119.95, 31.79], '徐州': [117.18, 34.26], '南通': [120.86, 32.01],
        '潍坊': [119.10, 36.62], '烟台': [121.39, 37.52], '洛阳': [112.44, 34.70],
        '襄阳': [112.14, 32.02], '宜昌': [111.28, 30.70], '桂林': [110.28, 25.29],
        '三亚': [109.51, 18.25], '大理': [100.23, 25.61], '丽江': [100.23, 26.88],
        '泉州': [118.58, 24.93], '绍兴': [120.58, 30.01], '唐山': [118.02, 39.63],
        '邯郸': [114.47, 36.60], '保定': [115.48, 38.87], '包头': [109.84, 40.66],
        '赤峰': [118.87, 42.28], '大庆': [125.03, 46.59], '延边': [129.51, 42.91],
        '吉林': [126.55, 43.84], '齐齐哈尔': [123.97, 47.33], '锦州': [121.13, 41.10],
        '秦皇岛': [119.57, 39.94], '威海': [122.12, 37.51], '日照': [119.53, 35.42],
        '德州': [116.30, 37.45], '聊城': [115.99, 36.45], '菏泽': [115.44, 35.23],
        '开封': [114.31, 34.79], '新乡': [113.85, 35.30], '南阳': [112.53, 33.00],
        '岳阳': [113.09, 29.37], '株洲': [113.16, 27.83], '衡阳': [112.61, 26.89],
        '柳州': [109.40, 24.31], '梧州': [111.32, 23.48], '遵义': [106.83, 27.70],
        '绵阳': [104.68, 31.47], '宜宾': [104.56, 28.77], '泸州': [105.43, 28.87],
        '榆林': [109.77, 38.30], '咸阳': [108.72, 34.36], '宝鸡': [107.15, 34.38],
        '天水': [105.72, 34.58], '酒泉': [98.52, 39.74], '嘉峪关': [98.27, 39.80],
        '克拉玛依': [84.89, 45.60], '哈密': [93.44, 42.83]
    };
    if (map[city]) return map[city];
    // 尝试带"市"/"区"后缀去除后再匹配
    const short = city.replace(/[市区]$/, '');
    if (map[short]) return map[short];
    // 省份首府兜底
    const capitalMap = { '广东': [113.23, 23.16], '浙江': [120.19, 30.26],
        '江苏': [118.78, 32.04], '四川': [104.06, 30.67], '湖北': [114.31, 30.52],
        '湖南': [112.98, 28.19], '河南': [113.65, 34.76], '山东': [117.00, 36.65],
        '福建': [119.30, 26.08], '辽宁': [123.38, 41.80], '黑龙江': [126.63, 45.75],
        '吉林': [125.35, 43.88], '云南': [102.73, 25.04], '贵州': [106.71, 26.57],
        '广西': [108.33, 22.84], '海南': [110.35, 20.02], '河北': [114.48, 38.03],
        '山西': [112.53, 37.87], '内蒙古': [111.65, 40.82], '甘肃': [103.73, 36.03],
        '青海': [101.74, 36.56], '宁夏': [106.27, 38.47], '新疆': [87.68, 43.77],
        '西藏': [91.11, 29.97], '江西': [115.89, 28.68], '安徽': [117.27, 31.86],
        '陕西': [108.95, 34.27]
    };
    const provinceShort = province ? province.replace(/[省市]$/, '') : '';
    if (capitalMap[provinceShort]) return capitalMap[provinceShort];
    return [116.46, 39.92]; // 最终兜底 → 北京
}
```

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: add ECharts China map rendering with city scatter"
```

---

### Task 6: 前端 — 留言获取与提交 JS

**Files:**
- Modify: `index.html` — 在 Task 5 代码之后继续追加 JS

- [ ] **Step 1: 获取留言列表并渲染**

```javascript
async function loadComments() {
    try {
        const res = await fetch('/api/comments');
        const data = await res.json();
        if (!data.comments) return;

        // 渲染地图
        await ensureChinaMap();
        renderMapChart(data.comments);

        // 渲染留言列表
        const listEl = document.getElementById('comment-list');
        if (data.comments.length === 0) {
            listEl.innerHTML = '<p class="comment-empty">暂无留言，成为第一个点亮地图的人吧！</p>';
            return;
        }
        listEl.innerHTML = data.comments.map(c => {
            const time = new Date(c.created_at).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
            const location = c.city ? `${c.province || ''} ${c.city}` : (c.province || '未知地区');
            return `<div class="comment-item">
                <div class="comment-item-header">
                    <span class="comment-item-nickname">${escHtml(c.nickname)}</span>
                    <span class="comment-item-location">${escHtml(location)}</span>
                    <span class="comment-item-time">${time}</span>
                </div>
                <p class="comment-item-content">${escHtml(c.content)}</p>
            </div>`;
        }).join('');
    } catch (err) {
        console.error('加载留言失败:', err);
    }
}

function escHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
```

- [ ] **Step 2: 提交留言逻辑**

```javascript
async function submitComment() {
    const nicknameEl = document.getElementById('cmt-nickname');
    const contentEl = document.getElementById('cmt-content');
    const submitBtn = document.getElementById('cmt-submit');
    const errorEl = document.getElementById('cmt-error');
    const successEl = document.getElementById('cmt-success');

    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    const nickname = nicknameEl.value.trim();
    const content = contentEl.value.trim();

    if (!nickname) { errorEl.textContent = '请输入昵称'; errorEl.style.display = 'block'; return; }
    if (!content) { errorEl.textContent = '请输入留言内容'; errorEl.style.display = 'block'; return; }
    if (nickname.length > 20) { errorEl.textContent = '昵称最多 20 个字符'; errorEl.style.display = 'block'; return; }
    if (content.length > 500) { errorEl.textContent = '留言最多 500 个字符'; errorEl.style.display = 'block'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';

    try {
        const res = await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, content })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error || '提交失败';
            errorEl.style.display = 'block';
            return;
        }
        successEl.style.display = 'block';
        nicknameEl.value = '';
        contentEl.value = '';
        await loadComments(); // 刷新地图和列表
        setTimeout(() => { successEl.style.display = 'none'; }, 4000);
    } catch {
        errorEl.textContent = '网络错误，请稍后再试';
        errorEl.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '点亮地图';
        // 重新加上 SVG（因为 textContent 覆盖了 innerHTML）
        submitBtn.innerHTML = '点亮地图 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>';
    }
}
```

- [ ] **Step 3: 在 switchTab 中添加 guest-map 分支**

修改 `switchTab` 函数，在视图切换后判断是否为 guest-map：

在 `switchTab` 函数末尾（`setTimeout(teleportMascot, 300);` 之后）添加：

```javascript
if (tabId === 'guest-map') {
    setTimeout(loadComments, 100);
}
```

完整修改后 `switchTab` 函数为：

```javascript
function switchTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if(document.getElementById('nav-' + tabId)) {
        document.getElementById('nav-' + tabId).classList.add('active');
    }

    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
    document.getElementById('view-' + tabId).classList.add('active-view');

    document.getElementById('header-breadcrumb').innerText = pagesConfig[tabId].breadcrumb;
    document.getElementById('header-title').innerText = pagesConfig[tabId].title;

    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(teleportMascot, 300);

    if (tabId === 'guest-map') {
        setTimeout(loadComments, 100);
    }
}
```

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: add comment fetch and submit logic"
```

---

### Task 7: 前端 — 暗色/亮色模式 ECharts 适配

**Files:**
- Modify: `index.html` — 修改 `toggleTheme` 函数

- [ ] **Step 1: 修改 toggleTheme 以触发地图重绘**

将现有 `toggleTheme` 函数（约 903-911 行）替换为：

```javascript
function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const target = current === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', target);

    document.getElementById('moon-icon').style.display = target === 'light' ? 'block' : 'none';
    document.getElementById('sun-icon').style.display = target === 'dark' ? 'block' : 'none';

    // 如果留言地图可见，重绘 ECharts
    if (document.getElementById('view-guest-map').classList.contains('active-view') && mapChart) {
        loadComments(); // 重新拉数据并切换地图配色
    }
}
```

- [ ] **Step 2: 提交**

```bash
git add index.html
git commit -m "feat: re-render map on theme toggle"
```

---

### Task 8: 前端 — 后台管理页面

**Files:**
- Modify: `index.html` — 在 `view-guest-map` 后面添加管理 HTML
- Modify: `index.html` — 新增管理 JS

- [ ] **Step 1: 在 `view-guest-map` 关闭标签后（comment-list div 之后）添加管理面板 HTML**

```html
<!-- 后台管理面板（通过 URL hash #admin 进入） -->
<div class="admin-section" id="admin-section">
    <div class="back-nav" onclick="hideAdmin()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        返回留言地图
    </div>
    <div class="admin-auth" id="admin-auth">
        <input type="password" id="admin-password" placeholder="请输入管理密码" maxlength="50">
        <button class="try-btn" onclick="adminLogin()">验证</button>
        <p id="admin-error" class="comment-error" style="display:none"></p>
    </div>
    <div id="admin-dashboard" style="display:none">
        <div class="admin-stats">
            <div class="admin-stat-card"><div class="admin-stat-num" id="stat-total">0</div><div class="admin-stat-label">总留言数</div></div>
            <div class="admin-stat-card"><div class="admin-stat-num" id="stat-cities">0</div><div class="admin-stat-label">点亮城市数</div></div>
            <div class="admin-stat-card"><div class="admin-stat-num" id="stat-provinces">0</div><div class="admin-stat-label">覆盖省份数</div></div>
        </div>
        <div id="admin-map" class="map-container" style="height: 450px;"></div>
        <div class="admin-province-list" id="admin-province-list"></div>
    </div>
</div>
```

- [ ] **Step 2: 新增管理 JS 逻辑**

在 `<script>` 末尾追加：

```javascript
// --- 后台管理 ---
let adminPassword = '';
let adminData = null;
let adminChart = null;

function checkAdminHash() {
    if (window.location.hash === '#admin') {
        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
        document.getElementById('admin-section').classList.add('active');
        document.getElementById('header-breadcrumb').innerText = 'Pages / Admin';
        document.getElementById('header-title').innerText = '后台管理';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function hideAdmin() {
    document.getElementById('admin-section').classList.remove('active');
    document.getElementById('view-guest-map').classList.add('active-view');
    document.getElementById('header-breadcrumb').innerText = pagesConfig['guest-map'].breadcrumb;
    document.getElementById('header-title').innerText = pagesConfig['guest-map'].title;
    window.location.hash = '';
}

async function adminLogin() {
    const pw = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('admin-error');
    errorEl.style.display = 'none';

    if (!pw) { errorEl.textContent = '请输入密码'; errorEl.style.display = 'block'; return; }

    try {
        const res = await fetch(`/api/comments?admin=true&password=${encodeURIComponent(pw)}`);
        const data = await res.json();
        if (!res.ok) { errorEl.textContent = data.error || '密码错误'; errorEl.style.display = 'block'; return; }

        adminPassword = pw;
        adminData = data;
        document.getElementById('admin-auth').style.display = 'none';
        document.getElementById('admin-dashboard').style.display = 'block';
        renderAdminDashboard(data);
    } catch {
        errorEl.textContent = '网络错误'; errorEl.style.display = 'block';
    }
}

function renderAdminDashboard(data) {
    document.getElementById('stat-total').textContent = data.total;
    document.getElementById('stat-cities').textContent = data.cities;
    document.getElementById('stat-provinces').textContent = data.provinces.length;

    // 省份榜单
    const sorted = data.provinces.sort((a, b) => b.count - a.count);
    document.getElementById('admin-province-list').innerHTML = sorted.map(p =>
        `<span class="admin-province-tag">${p.name}: ${p.count}</span>`
    ).join('');

    // 管理页地图
    ensureChinaMap().then(() => {
        const dom = document.getElementById('admin-map');
        if (!adminChart) {
            adminChart = echarts.init(dom);
            window.addEventListener('resize', () => adminChart && adminChart.resize());
        }
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const cityCount = {};
        data.comments.forEach(c => {
            if (!c.city) return;
            const key = `${c.province || ''}-${c.city}`;
            cityCount[key] = (cityCount[key] || 0) + 1;
        });
        const scatterData = Object.entries(cityCount).map(([key, count]) => {
            const [province, city] = key.split('-');
            return { name: city, value: [...getCityCoord(city, province), count] };
        });
        adminChart.setOption({
            backgroundColor: isDark ? '#1a1919' : '#fefcf5',
            tooltip: { trigger: 'item', formatter: p => p.seriesType === 'scatter' ? `${p.name}: ${p.value[2]} 条留言` : p.name },
            geo: {
                map: 'china', roam: false, zoom: 1.2, center: [104, 35],
                itemStyle: { areaColor: isDark ? '#2d2b2b' : '#f0ede5', borderColor: isDark ? '#3a3a3a' : '#ddd', borderWidth: 0.5 },
                emphasis: { itemStyle: { areaColor: isDark ? '#3d3b3b' : '#e0dcd0' } },
                label: { show: false }
            },
            series: [{
                type: 'scatter', coordinateSystem: 'geo', data: scatterData,
                symbolSize: val => Math.min(8 + val[2] * 4, 40),
                itemStyle: { color: '#d97757', shadowBlur: 10, shadowColor: '#d97757' }
            }]
        }, true);
    });
}

window.addEventListener('hashchange', checkAdminHash);
```

- [ ] **Step 3: 在 window.onload 中添加**

在 `window.onload` 函数末尾（`window.addEventListener('resize', teleportMascot);` 之前）添加：

```javascript
checkAdminHash();
```

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: add admin dashboard with password-protected stats and map"
```

---

### Task 9: 部署配置

**Files:**
- Create: `vercel.json`
- Modify: `.gitignore`（确保存在）

- [ ] **Step 1: 创建 `vercel.json`**

```json
{
  "functions": {
    "api/comments.js": {
      "memory": 256,
      "maxDuration": 10
    }
  }
}
```

- [ ] **Step 2: 确认 `.gitignore`**

检查或创建 `.gitignore`，至少包含：

```
.env
node_modules/
```

注意：`.env.example` 应被提交（不含真实密钥）。

- [ ] **Step 3: 安装依赖并本地测试**

```bash
cd api && npm install
```

本地启动 Vercel Dev：
```bash
npx vercel dev
```

测试 `POST /api/comments`：
```bash
curl -X POST http://localhost:3000/api/comments \
  -H "Content-Type: application/json" \
  -d '{"nickname":"测试用户","content":"这是一条测试留言"}'
```

测试 `GET /api/comments`：
```bash
curl http://localhost:3000/api/comments
```

- [ ] **Step 4: 部署到生产环境**

```bash
npx vercel link          # 关联 Vercel 项目
npx vercel env add ADMIN_PASSWORD  # 设置管理密码
npx vercel --prod        # 生产部署
```

同时在 Vercel Dashboard → Settings → Environment Variables 中添加 `DATABASE_URL`。

- [ ] **Step 5: 提交**

```bash
git add vercel.json
git commit -m "chore: add Vercel deployment config"
```

---

### Task 10: 吉祥物适配 + 端到端验证

**Files:**
- Modify: `index.html` — `teleportMascot` 函数增加 guest-map 场景

- [ ] **Step 1: 在 teleportMascot 中新增 guest-map 场景**

在 `teleportMascot()` 函数中，在「场景 5」代码块（约 1014 行）之后、`if (hideouts.length === 0)` 之前，插入：

```javascript
// ================= 场景 6：留言地图 =================
else if (document.getElementById('view-guest-map').classList.contains('active-view')) {
    const mapPanel = document.querySelector('.map-panel');
    if (mapPanel) {
        const mRect = getAbsoluteRect(mapPanel);
        hideouts.push({ left: mRect.left + 20, top: mRect.top - 32, rotate: 0, el: mapPanel });
        hideouts.push({ left: mRect.right - 56, top: mRect.top - 32, rotate: 0, el: mapPanel });
    }
    document.querySelectorAll('#view-guest-map .submit-btn').forEach(btn => {
        const bRect = getAbsoluteRect(btn);
        hideouts.push({ left: bRect.left + 15, top: bRect.bottom, rotate: 180, el: btn });
    });
}
```

- [ ] **Step 2: 端到端验证清单**

在浏览器中验证：

1. 打开网站，点击「留言地图」导航 → 地图加载，留言列表显示
2. 输入昵称和留言，点击「点亮地图」→ 提交成功，列表刷新，地图出现新散点
3. 切换到暗色模式 → 地图颜色变为深色配色
4. 输入 `#admin` 到 URL → 输入密码 → 管理面板显示统计数据、省份榜单、全量地图
5. 移动端视口 → 地图和表单上下堆叠
6. 小精灵正常出现在留言地图页面的地图面板和按钮附近

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: add mascot attachments for guest map view"
```

---

## 总结

| 任务 | 内容 | 新建文件 | 修改文件 |
|------|------|----------|----------|
| 1 | Neon 建表 | `schema.sql` | — |
| 2 | Vercel API | `api/package.json`, `api/comments.js`, `.env.example` | — |
| 3 | 导航替换 | — | `index.html` |
| 4 | HTML + CSS | — | `index.html` |
| 5 | ECharts 地图 JS | — | `index.html` |
| 6 | 留言获取/提交 JS | — | `index.html` |
| 7 | 主题适配 | — | `index.html` |
| 8 | 后台管理 | — | `index.html` |
| 9 | 部署配置 | `vercel.json` | `.gitignore` |
| 10 | 吉祥物适配 + 验证 | — | `index.html` |
