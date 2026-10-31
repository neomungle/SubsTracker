// @ts-check
/**
 * 用真实生产备份（46 条 v2 订阅，fixtures/legacy-subscriptions-v2.json）跑完整迁移，
 * 断言每条订阅的所有字段值在 v3 存储中完全一致，且旧数据被原样保留。
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import legacy from '../fixtures/legacy-subscriptions-v2.json';
import app from '../../src/app.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import { ensureMigrations, _resetMigrationCache } from '../../src/data/migrate.js';

/** @type {any[]} */
const legacySubs = /** @type {any} */ (legacy);

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  _resetMigrationCache();
});

describe('真实备份数据迁移', () => {
  it('fixture 含 46 条订阅', () => {
    expect(Array.isArray(legacySubs)).toBe(true);
    expect(legacySubs).toHaveLength(46);
  });

  it('全部 46 条在 v3 中存活且字段值完全一致；旧 Key 与永久备份保留原始字节', async () => {
    const raw = JSON.stringify(legacySubs);
    await env.SUBSCRIPTIONS_KV.put('subscriptions', raw);

    const result = await ensureMigrations(env);
    expect(result.migrated).toBe(true);

    const ids = await subRepo.listIds(env);
    expect(ids).toEqual(legacySubs.map((s) => s.id)); // 顺序也保持

    for (const original of legacySubs) {
      const stored = await subRepo.getById(env, original.id);
      expect(stored).toEqual(original);
      // 逐字段严格比较（包括 paymentHistory 等嵌套结构）
      for (const key of Object.keys(original)) {
        expect(stored[key]).toStrictEqual(original[key]);
      }
      expect(Object.keys(stored).sort()).toEqual(Object.keys(original).sort());
    }

    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions')).toBe(raw);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBe(raw);

    // 每条订阅都生成了提醒规则，且不改动订阅本体
    for (const original of legacySubs) {
      expect(await env.SUBSCRIPTIONS_KV.get(`reminder_rules:${original.id}`)).toBeTruthy();
    }
  });

  it('迁移幂等：再次执行后数据不变', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify(legacySubs));
    await ensureMigrations(env);
    _resetMigrationCache();
    await env.SUBSCRIPTIONS_KV.delete('schema_version');
    await env.SUBSCRIPTIONS_KV.delete('migrate:subscriptions_v3');
    await ensureMigrations(env);
    const all = await subRepo.listAll(env);
    expect(all).toEqual(legacySubs);
  });

  it('迁移后列表 API 返回全部 46 条，存储不被派生字段污染', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify(legacySubs));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k', TIMEZONE: 'Asia/Shanghai' })
    );
    const login = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    const cookie = login.headers.get('Set-Cookie')?.split(';')[0] || '';
    const res = await app.request('/api/subscriptions', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(46);
    for (const item of list) {
      expect(Array.isArray(item.nameParts)).toBe(true);
      expect(Number.isInteger(item.daysLeft)).toBe(true);
    }
    for (const original of legacySubs) {
      expect(await subRepo.getById(env, original.id)).toEqual(original);
    }
  });
});
