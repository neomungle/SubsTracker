// 注：dashboard 业务逻辑较多，此处不启用 // @ts-check（依赖外部 currency 模块的复杂返回类型）
/**
 * 仪表盘统计 handler
 *
 * 改动：
 * - 用户时区从 config.TIMEZONE 读取（不再硬编码 'UTC'）
 * - schedulerStatus / schedulerStatusHistory 从新的 scheduler-logs.repo 取
 *   旧 'scheduler_status' / 'scheduler_status_history' 已废弃（迁移会清掉）
 *
 */
import { getAllSubscriptions } from '../../data/subscriptions.js';
import {
  getDynamicRates,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  getRecentPayments,
  getUpcomingRenewals,
  getExpenseByType,
  getExpenseByCategory,
  convertToCNY
} from '../../core/currency.js';
import { getCurrentTimeInTimezone, getDaysBetween, MS_PER_DAY } from '../../core/time.js';
import * as schedulerLogsRepo from '../../data/scheduler-logs.repo.js';

/** 每个周期单位对应的"一年有几个单位"（用于把单期金额归一化为年支出） */
const UNITS_PER_YEAR = { day: 365, week: 52, month: 12, year: 1 };

/**
 * 到期统计（仅启用中的订阅，按配置时区的自然日计算）。
 * - expired: 到期日早于今天
 * - expiringIn7Days / expiringIn30Days: 今天 ≤ 到期日 ≤ 今天+N 天（含今天到期）
 *
 * @param {any[]} subscriptions
 * @param {string} timezone
 * @param {Date} now
 */
function computeExpiryStats(subscriptions, timezone, now) {
  let expired = 0;
  let expiringIn7Days = 0;
  let expiringIn30Days = 0;
  for (const s of subscriptions) {
    if (!s || !s.isActive || !s.expiryDate) continue;
    const expiry = new Date(s.expiryDate);
    if (Number.isNaN(expiry.getTime())) continue;
    const days = getDaysBetween(now, expiry, timezone);
    if (days < 0) expired++;
    else {
      if (days <= 7) expiringIn7Days++;
      if (days <= 30) expiringIn30Days++;
    }
  }
  return { expired, expiringIn7Days, expiringIn30Days };
}

/**
 * 预估年支出（CNY）：启用中的订阅按 金额 × (每年单位数 / periodValue) 归一化，再换算为 CNY。
 * 金额为空/0、周期无效的订阅不计入（计入 skipped）。
 *
 * @param {any[]} subscriptions
 * @param {Record<string, number>} rates
 */
function computeEstimatedAnnualSpend(subscriptions, rates) {
  let amount = 0;
  let counted = 0;
  let skipped = 0;
  for (const s of subscriptions) {
    if (!s || !s.isActive) continue;
    const perPeriod = Number(s.amount);
    const periodValue = Number(s.periodValue) || 1;
    const unitsPerYear = UNITS_PER_YEAR[s.periodUnit || 'month'];
    if (!Number.isFinite(perPeriod) || perPeriod <= 0 || !unitsPerYear || periodValue <= 0) {
      skipped++;
      continue;
    }
    amount += convertToCNY(perPeriod * (unitsPerYear / periodValue), s.currency, rates);
    counted++;
  }
  return {
    amount: Math.round(amount * 100) / 100,
    monthly: Math.round((amount / 12) * 100) / 100,
    currency: 'CNY',
    countedSubscriptions: counted,
    skippedSubscriptions: skipped
  };
}

async function handleDashboardStats(env, config) {
  try {
    const subscriptions = await getAllSubscriptions(env);
    const timezone = (config && config.TIMEZONE) || 'UTC';

    /** 本次：从结构化日志库读最新调度状态 */
    let schedulerStatus = null;
    let schedulerStatusHistory = [];
    try {
      const recent = await schedulerLogsRepo.getRecent(env, 10);
      schedulerStatusHistory = recent;
      // 兼容老前端字段：转一份扁平结构
      if (recent.length > 0) {
        const head = recent[0];
        schedulerStatus = {
          lastRunAt: head.startedAt,
          timezone: head.timezone,
          currentHour: head.currentHour,
          configuredHours: head.configuredHours,
          shouldNotifyThisHour: head.inWindow,
          checkedSubscriptions: head.checkedCount,
          activeSubscriptions: head.checkedCount,
          expiringMatched: head.matchedCount,
          dedupeSkipped: head.dedupedCount,
          updatedSubscriptions: head.autoRenewedCount,
          sent: head.sentCount > 0,
          reason: head.reason,
          status: head.status,
          extra: head.extra
        };
      }
    } catch (error) {
      console.error('读取调度日志失败:', error);
    }

    const rates = await getDynamicRates(env);
    const monthlyExpense = calculateMonthlyExpense(subscriptions, timezone, rates);
    const yearlyExpense = calculateYearlyExpense(subscriptions, timezone, rates);
    const recentPayments = getRecentPayments(subscriptions, timezone);
    const upcomingRenewals = getUpcomingRenewals(subscriptions, timezone);
    const expenseByType = getExpenseByType(subscriptions, timezone, rates);
    const expenseByCategory = getExpenseByCategory(subscriptions, timezone, rates);

    const activeSubscriptions = subscriptions.filter((s) => s.isActive);
    const now = getCurrentTimeInTimezone(timezone);
    const sevenDaysLater = new Date(now.getTime() + 7 * MS_PER_DAY);
    const expiringSoon = activeSubscriptions.filter((s) => {
      const expiryDate = new Date(s.expiryDate);
      return expiryDate >= now && expiryDate <= sevenDaysLater;
    }).length;

    const expiryStats = computeExpiryStats(subscriptions, timezone, now);
    const estimatedAnnualSpend = computeEstimatedAnnualSpend(subscriptions, rates);

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          monthlyExpense,
          yearlyExpense,
          activeSubscriptions: {
            active: activeSubscriptions.length,
            total: subscriptions.length,
            expiringSoon
          },
          recentPayments,
          upcomingRenewals,
          expenseByType,
          expenseByCategory,
          schedulerStatus,
          schedulerStatusHistory,
          /** 新增：用户时区（前端可据此显示） */
          timezone,
          /** 新增：到期统计（启用中订阅，按 TIMEZONE 自然日） */
          expiryStats,
          /** 新增：按周期归一化的预估年支出（CNY） */
          estimatedAnnualSpend
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('获取仪表盘统计失败:', error);
    return new Response(
      JSON.stringify({
        success: false,
        message: '获取统计数据失败: ' + (error && error.message ? error.message : error)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { handleDashboardStats };
