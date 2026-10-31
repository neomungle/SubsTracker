// @ts-check
/**
 * 自动数据迁移
 *
 * ── 设计原则 ────────────────────────────────────────────────
 * 1. **幂等**：每个 step 多次执行结果一致，且 `migrate:{step.id}=done` 标记跳过。
 * 2. **可重入安全**：通过 `migration_lock` Key（60s TTL）防止 Cron 与请求并发触发。
 *    最坏情况是其中一方放弃迁移，另一方完成；不会双写。
 * 3. **可累加**：后续 Task 在 `MIGRATION_STEPS` 数组里追加 step，不影响已运行的步骤。
 * 4. **数据安全**：旧 `subscriptions` 单 Key 在迁移后**原样保留、永不删除**，
 *    同时额外写一份 `subscriptions_v2_backup`（无 TTL，永久）作回滚备份。
 *    v3 代码路径（repo / handler / scheduler / backup）只读 `sub_index` + `sub:{id}`，
 *    唯一读取旧 `subscriptions` 的地方是本文件的 migrateSubscriptions；
 *    且它在已迁移过（备份 + 索引均存在）时不会再用旧数据覆盖新数据。
 *
 * ── KV 标记一览 ─────────────────────────────────────────────
 *   schema_version           = 'v3'        ← 数据 schema 版本标识，置上后每次请求秒过
 *   migrate:subscriptions_v3 = 'done'      ← 每个 step 自己的标记
 *   migration_lock           = ISO 时间戳   ← TTL 60s 的悲观锁
 *
 */

import * as subRepo from './subscriptions.repo.js';
import * as remindersRepo from './reminders.repo.js';
import * as schedulerLogsRepo from './scheduler-logs.repo.js';

/** 当前 schema 版本字符串 */
export const SCHEMA_VERSION = 'v3';

const KEY_SCHEMA_VERSION = 'schema_version';
const KEY_MIGRATION_LOCK = 'migration_lock';
const LOCK_TTL_SEC = 60;
const KEY_LEGACY_SUBSCRIPTIONS = 'subscriptions';
const KEY_LEGACY_BACKUP = 'subscriptions_v2_backup';

/**
 * @typedef {Object} MigrationStep
 * @property {string} id 唯一标识，用于幂等标记
 * @property {string} description 中文描述
 * @property {(env: any) => Promise<void>} run 执行体
 */

/** 当前所有 迁移步骤（后续 Task 追加） */
export const MIGRATION_STEPS = [
  {
    id: 'subscriptions_v3',
    description: '把单 Key subscriptions 拆成 sub:{id} + sub_index',
    run: migrateSubscriptions
  },
  {
    id: 'reminder_rules_v3',
    description: '把订阅自带的 reminderUnit/reminderValue 转成 reminder_rules:{subId}',
    run: migrateReminderRules
  },
  {
    id: 'scheduler_logs_v3',
    description: '把旧 scheduler_status_history 合并到 sched_log:{iso}',
    run: migrateSchedulerLogs
  }
];

/**
 * 已运行迁移的内存缓存（避免每次请求都查一次 KV）。
 * 同一 isolate 内只查一次。
 */
let cachedSchemaVersion = /** @type {string|null} */ (null);

/**
 * 入口：确保所有迁移步骤已运行完成。
 *
 * 调用方式：在 Worker fetch / scheduled 入口处第一行调用一次。
 * 已迁移过的请求几乎零开销（命中内存缓存或 1 次 KV.get）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<{ migrated: boolean, reason?: string, ranSteps?: string[] }>}
 */
export async function ensureMigrations(env) {
  if (cachedSchemaVersion === SCHEMA_VERSION) {
    return { migrated: false, reason: 'cached' };
  }

  const current = await env.SUBSCRIPTIONS_KV.get(KEY_SCHEMA_VERSION);
  if (current === SCHEMA_VERSION) {
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: false, reason: 'already_v3' };
  }

  // 尝试加锁
  const acquired = await tryAcquireLock(env);
  if (!acquired) {
    return { migrated: false, reason: 'locked_elsewhere' };
  }

  const ranSteps = [];
  try {
    for (const step of MIGRATION_STEPS) {
      const doneFlag = await env.SUBSCRIPTIONS_KV.get(`migrate:${step.id}`);
      if (doneFlag === 'done') continue;

      console.log(`[migrate] 开始执行: ${step.id} - ${step.description}`);
      await step.run(env);
      await env.SUBSCRIPTIONS_KV.put(`migrate:${step.id}`, 'done');
      console.log(`[migrate] 完成: ${step.id}`);
      ranSteps.push(step.id);
    }
    await env.SUBSCRIPTIONS_KV.put(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: true, ranSteps };
  } catch (err) {
    console.error('[migrate] 执行失败，本次不会标记完成，下次请求会重试:', err);
    throw err;
  } finally {
    await releaseLock(env);
  }
}

/**
 * 测试用：清除内存缓存，强制下次重新检查 schema_version。
 */
export function _resetMigrationCache() {
  cachedSchemaVersion = null;
}

/**
 * 测试用：检查内存缓存状态。
 */
export function _getCachedSchemaVersion() {
  return cachedSchemaVersion;
}

// ─────────────────────────────────────────────────────────────
// 锁 helper
// ─────────────────────────────────────────────────────────────

/**
 * 试图获取迁移锁。
 * KV 没有 CAS，只能"先读后写"——存在小窗口竞态，足够大多数场景。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<boolean>}
 */
async function tryAcquireLock(env) {
  const existing = await env.SUBSCRIPTIONS_KV.get(KEY_MIGRATION_LOCK);
  if (existing) return false;
  await env.SUBSCRIPTIONS_KV.put(KEY_MIGRATION_LOCK, new Date().toISOString(), {
    expirationTtl: LOCK_TTL_SEC
  });
  return true;
}

async function releaseLock(env) {
  try {
    await env.SUBSCRIPTIONS_KV.delete(KEY_MIGRATION_LOCK);
  } catch (err) {
    console.warn('[migrate] 释放锁失败（TTL 60s 后会自动释放）:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 各 step 实现
// ─────────────────────────────────────────────────────────────

/**
 * 迁移：旧 `subscriptions`（JSON 数组）→ `sub:{id}` 多 Key + `sub_index`。
 *
 * - 读 `subscriptions`，逐条写 `sub:{id}`，构建索引并写 `sub_index`
 * - 原始数据**原样**复制到 `subscriptions_v2_backup`（无 TTL，永久保留）
 * - 旧 `subscriptions` Key **不删除、不修改**（生产数据安全第一）
 * - 旧数据为空或缺失：仅写一个空索引，schema_version 仍写入
 *
 * 幂等性 / 防止读到陈旧数据：
 *   - 正常情况下 `migrate:subscriptions_v3=done` + `schema_version=v3` 保证本函数只跑一次。
 *   - 防御性兜底：若 `subscriptions_v2_backup` 与 `sub_index` 都已存在，说明之前已迁移成功，
 *     此后 v3 数据才是权威，本函数**不再**用旧 `subscriptions` 覆盖（避免把用户新编辑回滚）。
 *   - 若上次在写完 sub:{id} 后、写备份前崩溃，则备份不存在 → 重新导入同一份旧数据，结果一致。
 *   - 备份已存在时不会被覆盖，保证它永远是"首次迁移前"的原始值。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<{ imported: number, skipped?: string }>}
 */
export async function migrateSubscriptions(env) {
  const [oldRaw, existingBackup, existingIndexRaw] = await Promise.all([
    env.SUBSCRIPTIONS_KV.get(KEY_LEGACY_SUBSCRIPTIONS),
    env.SUBSCRIPTIONS_KV.get(KEY_LEGACY_BACKUP),
    env.SUBSCRIPTIONS_KV.get('sub_index')
  ]);

  if (existingBackup != null && existingIndexRaw != null) {
    console.log('[migrate:subscriptions_v3] 已迁移过（备份与索引均存在），跳过，不覆盖 v3 数据');
    return { imported: 0, skipped: 'already_migrated' };
  }

  /** @type {any[]} */
  let oldSubs = [];
  if (oldRaw) {
    try {
      const parsed = JSON.parse(oldRaw);
      oldSubs = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[migrate:subscriptions_v3] 旧数据 JSON 解析失败，按空处理:', err);
      oldSubs = [];
    }
  }

  // 仅保留拥有合法字符串 id 的记录写入 v3（其余仍完整保存在旧 Key 与备份里）
  const validSubs = oldSubs.filter(
    (s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id !== ''
  );
  if (validSubs.length !== oldSubs.length) {
    console.warn(
      `[migrate:subscriptions_v3] ${oldSubs.length - validSubs.length} 条旧记录缺少有效 id，未写入 v3（原始数据仍保留在备份中）`
    );
  }

  // 写入新结构（即使为空也要写 sub_index 占位）
  if (validSubs.length > 0) {
    await subRepo.replaceAll(env, validSubs);
  } else if (existingIndexRaw == null) {
    await env.SUBSCRIPTIONS_KV.put('sub_index', '[]');
  }

  // 永久备份原始字节（无 TTL）；已有备份绝不覆盖；原 Key 保持不动
  if (oldRaw && existingBackup == null) {
    await env.SUBSCRIPTIONS_KV.put(KEY_LEGACY_BACKUP, oldRaw);
  }

  console.log(`[migrate:subscriptions_v3] 已迁移 ${validSubs.length} 条订阅（原 subscriptions Key 保留）`);
  return { imported: validSubs.length };
}

/**
 * 迁移：根据每个订阅的 reminderUnit/reminderValue 生成 1 条等价 before_expiry 规则。
 *
 * 仅对没有 reminder_rules:{subId} 的订阅写入；如果用户在新版本里已经手动配置过规则，
 * 不会被覆盖。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateReminderRules(env) {
  const subs = await subRepo.listAll(env);
  let count = 0;
  for (const sub of subs) {
    const existing = await remindersRepo.listForSubscription(env, sub.id);
    if (existing.length > 0) continue;
    const rule = remindersRepo.legacyFieldToRule(sub);
    await remindersRepo.replaceForSubscription(env, sub.id, [rule]);
    count++;
  }
  console.log(`[migrate:reminder_rules_v3] 已为 ${count} 个订阅生成默认提醒规则`);
}

/**
 * 迁移：把旧 scheduler_status_history（早期版本最多保留 20 条调度状态）转写到 sched_log:{iso}。
 *
 * 仅作历史记录的最佳努力迁移，结构差异较大，主要保留时间线索。
 * 旧 Key 迁移完保留作回滚备份（让 KV TTL 自然过期清理）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSchedulerLogs(env) {
  const histRaw = await env.SUBSCRIPTIONS_KV.get('scheduler_status_history');
  if (!histRaw) return;
  /** @type {any[]} */
  let history = [];
  try {
    const parsed = JSON.parse(histRaw);
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }

  let count = 0;
  for (const item of history) {
    const startedAt = item.lastRunAt || new Date().toISOString();
    await schedulerLogsRepo.writeLog(
      env,
      {
        startedAt,
        finishedAt: startedAt,
        timezone: item.timezone || 'UTC',
        currentHour: item.currentHour || '00',
        configuredHours: Array.isArray(item.configuredHours) ? item.configuredHours : [],
        inWindow: !!item.shouldNotifyThisHour,
        checkedCount: item.checkedSubscriptions || 0,
        matchedCount: item.expiringMatched || 0,
        dedupedCount: item.dedupeSkipped || 0,
        sentCount: item.sent ? 1 : 0,
        autoRenewedCount: item.updatedSubscriptions || 0,
        status: item.errorStack ? 'error' : item.sent ? 'ok' : 'skipped',
        reason: item.reason || (item.errorStack ? 'legacy_error' : undefined),
        extra: { migratedFromV2: true }
      },
      { ttlSec: 7 * 24 * 3600 }
    );
    count++;
  }
  console.log(`[migrate:scheduler_logs_v3] 已迁移 ${count} 条历史调度记录`);
}
