// @ts-check
/**
 * 新增能力：
 * - GET 列表 / 单条的派生字段 nameParts / daysLeft（不落库，写入路径会剥离）
 * - POST /api/subscriptions/:id/renew 空 body 一键续订 1 个周期
 * - POST /api/subscriptions/batch 批量 renew / enable / disable / delete
 * - GET /api/dashboard/stats 新增 expiryStats / estimatedAnnualSpend
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { getTimezoneDateParts } from '../../src/core/time.js';
import { computeNameParts, stripDerivedFields } from '../../src/data/derived.js';

const TZ = 'Asia/Shanghai';
const NOW = 'Sun 2026-05-24 8:00 AM CST (UTC+08:00)';

/** 东八区某日零点的 ISO */
function cst(dateStr) {
  return new Date(`${dateStr}T00:00:00+08:00`).toISOString();
}

/** ISO → 东八区 YYYY-MM-DD */
function ymd(iso) {
  const p = getTimezoneDateParts(new Date(iso), TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k', TIMEZONE: TZ })
  );
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  }, env);
  return res.headers.get('Set-Cookie')?.split(';')[0] || '';
}

/** @param {Record<string, any>} over */
function makeSub(over) {
  return {
    name: 'Sub',
    customType: '',
    category: '',
    amount: 10,
    currency: 'CNY',
    periodValue: 1,
    periodUnit: 'month',
    startDate: cst('2026-01-01'),
    expiryDate: cst('2026-06-10'),
    reminderUnit: 'day',
    reminderValue: 7,
    reminderDays: 7,
    isActive: true,
    autoRenew: true,
    useLunar: false,
    notes: '',
    paymentHistory: [],
    lastPaymentDate: cst('2026-01-01'),
    subscriptionMode: 'cycle',
    createdAt: cst('2026-01-01'),
    ...over
  };
}

beforeEach(async () => {
  await clearKv();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe('derived 工具函数', () => {
  it('computeNameParts 按空白/逗号/全角逗号/分号/Tab 拆分并去空', () => {
    expect(computeNameParts('a.com, b.com，c.com;d.com\te.com   f.com；g.com')).toEqual([
      'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com'
    ]);
    expect(computeNameParts('  Netflix  ')).toEqual(['Netflix']);
    expect(computeNameParts(',,， ;')).toEqual([]);
    expect(computeNameParts(undefined)).toEqual([]);
  });

  it('stripDerivedFields 去掉 nameParts/daysLeft 且不修改入参', () => {
    const body = { name: 'x', nameParts: ['x'], daysLeft: 3 };
    expect(stripDerivedFields(body)).toEqual({ name: 'x' });
    expect(body.daysLeft).toBe(3);
  });
});

describe('GET 派生字段 nameParts / daysLeft', () => {
  it('列表与单条都带派生字段，且 KV 中不存在', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'd1', name: 'a.dpdns.org  b.qzz.io，c.io', expiryDate: cst('2026-06-10') }));
    await subRepo.save(env, makeSub({ id: 'd2', name: 'Today', expiryDate: cst('2026-05-24') }));
    await subRepo.save(env, makeSub({ id: 'd3', name: 'Past', expiryDate: cst('2026-05-20') }));

    const res = await app.request('/api/subscriptions', { headers: { Cookie: cookie } }, env);
    const list = await res.json();
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId.d1.nameParts).toEqual(['a.dpdns.org', 'b.qzz.io', 'c.io']);
    expect(byId.d1.daysLeft).toBe(17);
    expect(byId.d2.daysLeft).toBe(0);
    expect(byId.d3.daysLeft).toBe(-4);

    const one = await (await app.request('/api/subscriptions/d1', { headers: { Cookie: cookie } }, env)).json();
    expect(one.nameParts).toEqual(['a.dpdns.org', 'b.qzz.io', 'c.io']);
    expect(one.daysLeft).toBe(17);

    const stored = await subRepo.getById(env, 'd1');
    expect('nameParts' in stored).toBe(false);
    expect('daysLeft' in stored).toBe(false);
  });

  it('PUT 回传派生字段不会被持久化', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'p1', name: 'x.com y.com' }));
    const one = await (await app.request('/api/subscriptions/p1', { headers: { Cookie: cookie } }, env)).json();
    const res = await app.request('/api/subscriptions/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...one, notes: 'edited', nameParts: ['bogus'], daysLeft: 999 })
    }, env);
    expect(res.status).toBe(200);
    const stored = await subRepo.getById(env, 'p1');
    expect(stored.notes).toBe('edited');
    expect('nameParts' in stored).toBe(false);
    expect('daysLeft' in stored).toBe(false);
  });

  it('POST 回传派生字段不会被持久化', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'n1 n2', expiryDate: '2026-07-01', nameParts: ['z'], daysLeft: 1 })
    }, env);
    expect(res.status).toBe(201);
    const { subscription } = await res.json();
    const stored = await subRepo.getById(env, subscription.id);
    expect('nameParts' in stored).toBe(false);
    expect('daysLeft' in stored).toBe(false);
  });
});

describe('POST /api/subscriptions/:id/renew 一键续订', () => {
  /**
   * @param {string} cookie
   * @param {string} id
   * @param {RequestInit} [extra]
   */
  async function renew(cookie, id, extra = {}) {
    return app.request(`/api/subscriptions/${id}/renew`, {
      method: 'POST',
      headers: { Cookie: cookie },
      ...extra
    }, env);
  }

  it('cycle + 未到期：无 body → 从原到期日接续 1 个周期，返回新 expiryDate 并记录支付', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r1', amount: 25 }));
    const res = await renew(cookie, 'r1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(ymd(body.expiryDate)).toBe('2026-07-10');
    expect(body.subscription.expiryDate).toBe(body.expiryDate);
    expect(body.subscription.daysLeft).toBe(47);

    const stored = await subRepo.getById(env, 'r1');
    expect(stored.expiryDate).toBe(body.expiryDate);
    expect(stored.paymentHistory).toHaveLength(1);
    expect(stored.paymentHistory[0]).toMatchObject({ type: 'manual', amount: 25, currency: 'CNY' });
    expect(ymd(stored.paymentHistory[0].periodStart)).toBe('2026-06-10');
    expect('daysLeft' in stored).toBe(false);
  });

  it('空字符串 body 与 {} body 结果一致（仅续 1 个周期）', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r2' }));
    await subRepo.save(env, makeSub({ id: 'r3' }));
    const a = await (await renew(cookie, 'r2', { body: '' })).json();
    const b = await (await renew(cookie, 'r3', {
      body: '{}',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }
    })).json();
    expect(ymd(a.expiryDate)).toBe('2026-07-10');
    expect(ymd(b.expiryDate)).toBe('2026-07-10');
  });

  it('cycle + 已过期 → 从今天起算 1 个周期', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r4', expiryDate: cst('2026-04-01') }));
    const body = await (await renew(cookie, 'r4')).json();
    expect(ymd(body.expiryDate)).toBe('2026-06-24');
  });

  it('reset 模式 → 总是从今天起算', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r5', subscriptionMode: 'reset', expiryDate: cst('2026-06-10') }));
    const body = await (await renew(cookie, 'r5')).json();
    expect(ymd(body.expiryDate)).toBe('2026-06-24');
  });

  it('endOfMonth：6/30 续 1 个月 → 7/31；未开启则 → 7/30', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r6', expiryDate: cst('2026-06-30'), endOfMonth: true }));
    await subRepo.save(env, makeSub({ id: 'r7', expiryDate: cst('2026-06-30') }));
    expect(ymd((await (await renew(cookie, 'r6')).json()).expiryDate)).toBe('2026-07-31');
    expect(ymd((await (await renew(cookie, 'r7')).json()).expiryDate)).toBe('2026-07-30');
  });

  it('按天周期：periodValue=30 day', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r8', periodUnit: 'day', periodValue: 30, expiryDate: cst('2026-06-10') }));
    expect(ymd((await (await renew(cookie, 'r8')).json()).expiryDate)).toBe('2026-07-10');
  });

  it('农历：端午（2026-06-19，农历五月初五）续 1 年 → 2027 年端午（2027-06-09）', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'r9', useLunar: true, periodUnit: 'year', expiryDate: cst('2026-06-19') }));
    expect(ymd((await (await renew(cookie, 'r9')).json()).expiryDate)).toBe('2027-06-09');
  });

  it('不存在的订阅 → 400', async () => {
    const cookie = await loginCookie();
    const res = await renew(cookie, 'nope');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/subscriptions/batch', () => {
  /**
   * @param {string} cookie
   * @param {any} body
   */
  async function batch(cookie, body) {
    return app.request('/api/subscriptions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    }, env);
  }

  it('未登录 → 401', async () => {
    await loginCookie();
    const res = await app.request('/api/subscriptions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['a'], action: 'renew' })
    }, env);
    expect(res.status).toBe(401);
  });

  it('参数校验：非法 action / 空 ids / 非法 JSON → 400', async () => {
    const cookie = await loginCookie();
    expect((await batch(cookie, { ids: ['a'], action: 'explode' })).status).toBe(400);
    expect((await batch(cookie, { ids: [], action: 'renew' })).status).toBe(400);
    expect((await batch(cookie, { ids: [''], action: 'renew' })).status).toBe(400);
    expect((await batch(cookie, '{nope')).status).toBe(400);
  });

  it('renew：与单条 renew 语义一致，逐条返回结果（含不存在的 id）', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'b1', amount: 5 }));
    await subRepo.save(env, makeSub({ id: 'b2', expiryDate: cst('2026-04-01') }));
    const res = await batch(cookie, { ids: ['b1', 'b2', 'missing', 'b1'], action: 'renew' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, action: 'renew', total: 3, succeeded: 2, failed: 1 });
    const byId = Object.fromEntries(body.results.map((r) => [r.id, r]));
    expect(ymd(byId.b1.expiryDate)).toBe('2026-07-10');
    expect(ymd(byId.b2.expiryDate)).toBe('2026-06-24');
    expect(byId.b1.subscription.nameParts).toEqual(['Sub']);
    expect(byId.missing).toMatchObject({ success: false, message: '订阅不存在' });

    // 去重：b1 只续了一次
    const b1 = await subRepo.getById(env, 'b1');
    expect(b1.paymentHistory).toHaveLength(1);
    expect(b1.paymentHistory[0]).toMatchObject({ type: 'manual', amount: 5 });
    expect('nameParts' in b1).toBe(false);
  });

  it('disable / enable', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'e1' }));
    await subRepo.save(env, makeSub({ id: 'e2' }));
    let body = await (await batch(cookie, { ids: ['e1', 'e2'], action: 'disable' })).json();
    expect(body.success).toBe(true);
    expect((await subRepo.getById(env, 'e1')).isActive).toBe(false);
    expect((await subRepo.getById(env, 'e2')).isActive).toBe(false);
    body = await (await batch(cookie, { ids: ['e2'], action: 'enable' })).json();
    expect(body.results[0]).toMatchObject({ id: 'e2', success: true });
    expect((await subRepo.getById(env, 'e2')).isActive).toBe(true);
    expect((await subRepo.getById(env, 'e1')).isActive).toBe(false);
  });

  it('delete：删除订阅 + 索引 + 提醒规则', async () => {
    const cookie = await loginCookie();
    await subRepo.save(env, makeSub({ id: 'x1' }));
    await subRepo.save(env, makeSub({ id: 'x2' }));
    await subRepo.save(env, makeSub({ id: 'keep' }));
    await remindersRepo.replaceForSubscription(env, 'x1', remindersRepo.defaultPresetRules());
    const body = await (await batch(cookie, { ids: ['x1', 'x2'], action: 'delete' })).json();
    expect(body).toMatchObject({ success: true, succeeded: 2, failed: 0 });
    expect(await subRepo.listIds(env)).toEqual(['keep']);
    expect(await env.SUBSCRIPTIONS_KV.get('reminder_rules:x1')).toBeNull();
  });
});

describe('GET /api/dashboard/stats 新字段', () => {
  it('expiryStats 与 estimatedAnnualSpend', async () => {
    const cookie = await loginCookie();
    await env.SUBSCRIPTIONS_KV.put(
      'SYSTEM_EXCHANGE_RATES',
      JSON.stringify({ ts: Date.now(), rates: { CNY: 1, USD: 0.125 } })
    );
    await subRepo.saveMany(env, [
      // 已过期（启用）
      makeSub({ id: 's1', expiryDate: cst('2026-05-20'), amount: 10, periodUnit: 'month', periodValue: 1 }), // 120
      // 今天到期（计入 7/30）
      makeSub({ id: 's2', expiryDate: cst('2026-05-24'), amount: 100, currency: 'USD', periodUnit: 'year', periodValue: 1 }), // 800
      // 20 天后（仅 30）
      makeSub({ id: 's3', expiryDate: cst('2026-06-13'), amount: 1, periodUnit: 'day', periodValue: 30 }), // 365/30
      // 60 天后，金额为空 → 不计入年支出
      makeSub({ id: 's4', expiryDate: cst('2026-07-23'), amount: null }),
      // 停用 + 已过期 → 全部不计
      makeSub({ id: 's5', expiryDate: cst('2026-05-01'), isActive: false, amount: 1000 }),
      // 第 7 天（边界，计入 7 与 30）, 2 年一付
      makeSub({ id: 's6', expiryDate: cst('2026-05-31'), amount: 200, periodUnit: 'year', periodValue: 2 }) // 100
    ]);

    const res = await app.request('/api/dashboard/stats', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.expiryStats).toEqual({ expired: 1, expiringIn7Days: 2, expiringIn30Days: 3 });
    expect(data.estimatedAnnualSpend.currency).toBe('CNY');
    expect(data.estimatedAnnualSpend.amount).toBeCloseTo(120 + 800 + 365 / 30 + 100, 2);
    expect(data.estimatedAnnualSpend.countedSubscriptions).toBe(4);
    expect(data.estimatedAnnualSpend.skippedSubscriptions).toBe(1);

    // 旧字段仍在
    expect(data.activeSubscriptions).toMatchObject({ active: 5, total: 6 });
    expect(data).toHaveProperty('monthlyExpense');
    expect(data).toHaveProperty('yearlyExpense');
    expect(data).toHaveProperty('upcomingRenewals');
    expect(data.timezone).toBe(TZ);
  });
});
