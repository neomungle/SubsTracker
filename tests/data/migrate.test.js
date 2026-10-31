// @ts-check
/**
 * 订阅仓库 + 迁移单元测试
 *
 * 用 @cloudflare/vitest-pool-workers 提供的真实 KVNamespace 跑，
 * 不需要手写 mock，直接 import { env } from 'cloudflare:test'。
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore — vitest-pool-workers 注入的虚拟模块
import { env } from 'cloudflare:test';

import * as subRepo from '../../src/data/subscriptions.repo.js';
import {
  ensureMigrations,
  migrateSubscriptions,
  SCHEMA_VERSION,
  _resetMigrationCache,
  _getCachedSchemaVersion
} from '../../src/data/migrate.js';

/** 把 KV 清空（仅遍历常见 KV key 前缀） */
async function clearKv() {
  // KV.list 在 vitest-pool-workers 是真实实现
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  _resetMigrationCache();
});

describe('subscriptions.repo', () => {
  it('listIds 空仓库返回空数组', async () => {
    expect(await subRepo.listIds(env)).toEqual([]);
    expect(await subRepo.listAll(env)).toEqual([]);
  });

  it('save 新订阅 → 索引追加 + 单 Key 写入', async () => {
    const sub = { id: 'a1', name: 'Netflix' };
    await subRepo.save(env, sub);

    expect(await subRepo.listIds(env)).toEqual(['a1']);
    expect(await subRepo.getById(env, 'a1')).toEqual(sub);
    expect(await subRepo.listAll(env)).toEqual([sub]);
  });

  it('save 已存在订阅 → 仅更新 sub:{id}，索引不变', async () => {
    await subRepo.save(env, { id: 'a1', name: 'Old' });
    await subRepo.save(env, { id: 'a1', name: 'New' });

    expect(await subRepo.listIds(env)).toEqual(['a1']);
    expect((await subRepo.getById(env, 'a1')).name).toBe('New');
  });

  it('saveMany 批量写入并合并索引', async () => {
    await subRepo.saveMany(env, [
      { id: 'b1', name: 'A' },
      { id: 'b2', name: 'B' },
      { id: 'b3', name: 'C' }
    ]);

    expect((await subRepo.listIds(env)).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(await subRepo.listAll(env)).toHaveLength(3);
  });

  it('deleteById 移除单 Key 与索引', async () => {
    await subRepo.save(env, { id: 'c1', name: 'X' });
    await subRepo.save(env, { id: 'c2', name: 'Y' });

    expect(await subRepo.deleteById(env, 'c1')).toBe(true);
    expect(await subRepo.listIds(env)).toEqual(['c2']);
    expect(await subRepo.getById(env, 'c1')).toBeNull();
  });

  it('deleteById 不存在 → 返回 false 且清理悬空索引', async () => {
    await env.SUBSCRIPTIONS_KV.put('sub_index', JSON.stringify(['ghost']));
    expect(await subRepo.deleteById(env, 'ghost')).toBe(false);
    expect(await subRepo.listIds(env)).toEqual([]);
  });

  it('replaceAll 整体替换（迁移用）', async () => {
    await subRepo.save(env, { id: 'old1' });
    await subRepo.save(env, { id: 'old2' });

    await subRepo.replaceAll(env, [{ id: 'new1' }, { id: 'new2' }, { id: 'new3' }]);

    expect((await subRepo.listIds(env)).sort()).toEqual(['new1', 'new2', 'new3']);
    expect(await subRepo.getById(env, 'old1')).toBeNull();
    expect(await subRepo.getById(env, 'new2')).toEqual({ id: 'new2' });
  });

  it('save 缺少 id 抛异常', async () => {
    await expect(subRepo.save(env, /** @type {any} */ ({}))).rejects.toThrow();
    await expect(subRepo.save(env, /** @type {any} */ ({ id: '' }))).rejects.toThrow();
  });
});

describe('migrate.migrateSubscriptions', () => {
  it('旧 subscriptions 数组 → 新 sub:{id} + sub_index + 备份', async () => {
    const old = [
      { id: 's1', name: 'Netflix' },
      { id: 's2', name: 'Spotify' },
      { id: 's3', name: 'AWS' }
    ];
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify(old));

    await migrateSubscriptions(env);

    expect((await subRepo.listIds(env)).sort()).toEqual(['s1', 's2', 's3']);
    expect((await subRepo.getById(env, 's2')).name).toBe('Spotify');

    // 备份存在且与原始字节一致；原 Key 原样保留（不再删除）
    const raw = JSON.stringify(old);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBe(raw);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions')).toBe(raw);
  });

  it('备份无 TTL（永久保留）', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify([{ id: 't1', name: 'A' }]));
    await migrateSubscriptions(env);
    const list = await env.SUBSCRIPTIONS_KV.list({ prefix: 'subscriptions' });
    const names = list.keys.map((k) => k.name).sort();
    expect(names).toEqual(['subscriptions', 'subscriptions_v2_backup']);
    for (const k of list.keys) {
      expect(k.expiration).toBeUndefined();
    }
  });

  it('重复执行不会用旧 subscriptions 覆盖 v3 中的新编辑，也不覆盖备份', async () => {
    const raw = JSON.stringify([{ id: 'e1', name: 'Original' }]);
    await env.SUBSCRIPTIONS_KV.put('subscriptions', raw);
    await migrateSubscriptions(env);

    // 用户在 v3 里编辑并新增
    await subRepo.save(env, { id: 'e1', name: 'Edited' });
    await subRepo.save(env, { id: 'e2', name: 'New' });

    const r = await migrateSubscriptions(env);
    expect(r.skipped).toBe('already_migrated');
    expect((await subRepo.getById(env, 'e1')).name).toBe('Edited');
    expect((await subRepo.listIds(env)).sort()).toEqual(['e1', 'e2']);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBe(raw);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions')).toBe(raw);
  });

  it('上次在写备份前中断 → 重跑会重新导入同一份旧数据（结果一致）', async () => {
    const raw = JSON.stringify([{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }]);
    await env.SUBSCRIPTIONS_KV.put('subscriptions', raw);
    // 模拟：sub:{id} 写了一半，备份未写
    await subRepo.save(env, { id: 'c1', name: 'A' });
    await migrateSubscriptions(env);
    expect((await subRepo.listIds(env)).sort()).toEqual(['c1', 'c2']);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBe(raw);
  });

  it('缺少有效 id 的旧记录不写入 v3，但原始数据完整保留', async () => {
    const raw = JSON.stringify([{ id: 'ok', name: 'A' }, { name: 'no-id' }, null]);
    await env.SUBSCRIPTIONS_KV.put('subscriptions', raw);
    await migrateSubscriptions(env);
    expect(await subRepo.listIds(env)).toEqual(['ok']);
    expect(await env.SUBSCRIPTIONS_KV.get('sub:undefined')).toBeNull();
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBe(raw);
  });

  it('旧 subscriptions 不存在 → 仅写空索引，不报错', async () => {
    await migrateSubscriptions(env);
    expect(await subRepo.listIds(env)).toEqual([]);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBeNull();
  });

  it('旧 subscriptions 是损坏 JSON → 按空处理不抛异常', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', '{ this is not valid json');
    await migrateSubscriptions(env);
    expect(await subRepo.listIds(env)).toEqual([]);
  });
});

describe('migrate.migrateSchedulerLogs', () => {
  it('迁移旧 scheduler_status_history 到 sched_log:*', async () => {
    const v2History = [
      {
        lastRunAt: '2026-05-24T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '18',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: true,
        checkedSubscriptions: 5,
        expiringMatched: 2,
        dedupeSkipped: 1,
        sent: true,
        updatedSubscriptions: 1,
        reason: '已尝试发送'
      },
      {
        lastRunAt: '2026-05-24T09:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '17',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: false,
        sent: false,
        reason: '当前小时未在通知时段内'
      }
    ];
    await env.SUBSCRIPTIONS_KV.put('scheduler_status_history', JSON.stringify(v2History));

    const { migrateSchedulerLogs } = await import('../../src/data/migrate.js');
    await migrateSchedulerLogs(env);

    const list = await env.SUBSCRIPTIONS_KV.list({ prefix: 'sched_log:' });
    expect(list.keys.length).toBe(2);
  });
});

describe('migrate.ensureMigrations（编排器）', () => {
  it('初次执行 → 设置 schema_version 与 step 标记', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'x1', name: 'X', reminderUnit: 'day', reminderValue: 5 }])
    );

    const result = await ensureMigrations(env);

    expect(result.migrated).toBe(true);
    expect(result.ranSteps).toContain('subscriptions_v3');
    expect(result.ranSteps).toContain('reminder_rules_v3');
    expect(result.ranSteps).toContain('scheduler_logs_v3');
    expect(await env.SUBSCRIPTIONS_KV.get('schema_version')).toBe(SCHEMA_VERSION);
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:subscriptions_v3')).toBe('done');
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:reminder_rules_v3')).toBe('done');
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:scheduler_logs_v3')).toBe('done');
    expect(_getCachedSchemaVersion()).toBe(SCHEMA_VERSION);

    // reminder rules 也已生成
    const rules = await env.SUBSCRIPTIONS_KV.get('reminder_rules:x1');
    expect(rules).toBeTruthy();
    const parsed = JSON.parse(/** @type {string} */ (rules));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].value).toBe(5);
  });

  it('schema_version 已就位 → 跳过，命中缓存', async () => {
    await env.SUBSCRIPTIONS_KV.put('schema_version', SCHEMA_VERSION);

    const r1 = await ensureMigrations(env);
    expect(r1.migrated).toBe(false);
    expect(r1.reason).toBe('already_v3');

    const r2 = await ensureMigrations(env);
    expect(r2.reason).toBe('cached'); // 二次走内存缓存
  });

  it('幂等：连续两次执行结果一致', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'idem', name: 'A' }])
    );
    await ensureMigrations(env);
    _resetMigrationCache();

    // 第二次：schema_version 已就位，应直接跳过
    const r2 = await ensureMigrations(env);
    expect(r2.migrated).toBe(false);
    expect(r2.reason).toBe('already_v3');

    expect((await subRepo.listIds(env)).length).toBe(1);
  });

  it('schema_version=v3 后即使旧 subscriptions Key 仍在（甚至被改动），也不会被读取', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'live', name: 'Before' }])
    );
    await ensureMigrations(env);
    await subRepo.save(env, { id: 'live', name: 'AfterEdit' });

    // 有人往旧 Key 写入陈旧/不同的内容，且即使 step 标记丢失
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'stale', name: 'Stale' }])
    );
    await env.SUBSCRIPTIONS_KV.delete('migrate:subscriptions_v3');
    _resetMigrationCache();

    const r = await ensureMigrations(env);
    expect(r.reason).toBe('already_v3');
    expect(await subRepo.listIds(env)).toEqual(['live']);
    expect((await subRepo.getById(env, 'live')).name).toBe('AfterEdit');

    // 再极端一点：schema_version 也丢了 → step 重跑，但备份+索引存在，仍不覆盖
    await env.SUBSCRIPTIONS_KV.delete('schema_version');
    _resetMigrationCache();
    const r2 = await ensureMigrations(env);
    expect(r2.migrated).toBe(true);
    expect(await subRepo.listIds(env)).toEqual(['live']);
    expect((await subRepo.getById(env, 'live')).name).toBe('AfterEdit');
  });

  it('锁存在时 → 跳过，下次再试', async () => {
    await env.SUBSCRIPTIONS_KV.put('migration_lock', 'someone-else-running');

    const result = await ensureMigrations(env);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('locked_elsewhere');

    // 没设置 schema_version
    expect(await env.SUBSCRIPTIONS_KV.get('schema_version')).toBeNull();
  });

  it('迁移成功后会自动释放锁', async () => {
    await ensureMigrations(env);
    expect(await env.SUBSCRIPTIONS_KV.get('migration_lock')).toBeNull();
  });
});
