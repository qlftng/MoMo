const { createClient } = require('@supabase/supabase-js');

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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Supabase 环境变量未设置', detail: '请检查 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY' });
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --- GET: 查询留言 ---
    if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const admin = url.searchParams.get('admin');
        const password = url.searchParams.get('password');

        try {
            if (admin === 'true') {
                const envPw = (process.env.ADMIN_PASSWORD || '').trim();
                if (!envPw) {
                    return res.status(500).json({ error: 'ADMIN_PASSWORD 环境变量未设置或为空' });
                }
                const inputPw = (password || '').trim();
                if (!inputPw || inputPw !== envPw) {
                    return res.status(403).json({
                        error: '密码错误',
                        detail: `输入="${inputPw}"(长度${inputPw.length}), 环境变量长度=${envPw.length}, 环境变量前4位="${envPw.slice(0, 4)}"`
                    });
                }
                const { data: rows, error } = await supabase
                    .from('comments')
                    .select('*')
                    .order('created_at', { ascending: false });

                if (error) throw error;

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

            const { data: rows, error } = await supabase
                .from('comments')
                .select('id, nickname, content, province, city, country, created_at')
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) throw error;

            return res.status(200).json({ comments: rows });
        } catch (err) {
            return res.status(500).json({ error: '数据库查询失败', detail: err.message });
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
            const { data: rows, error } = await supabase
                .from('comments')
                .insert({
                    nickname,
                    content,
                    province: geo.province,
                    city: geo.city,
                    country: geo.country
                })
                .select('id, nickname, content, province, city, country, created_at');

            if (error) throw error;

            return res.status(201).json({ ok: true, comment: rows[0] });
        } catch (err) {
            return res.status(500).json({ error: '留言提交失败', detail: err.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
