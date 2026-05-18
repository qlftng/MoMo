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
