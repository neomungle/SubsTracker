import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus
} from '../../data/subscriptions.js';
import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatTimeInTimezone, formatTimezoneDisplay, getTimezoneDateParts } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { extractTagsFromSubscriptions } from '../utils.js';
import { withDerivedFields, stripDerivedFields } from '../../data/derived.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BATCH_ACTIONS = ['renew', 'enable', 'disable', 'delete'];
const BATCH_MAX_IDS = 200;

/**
 * @param {any} env
 * @returns {Promise<string>}
 */
async function getTimezone(env) {
  const config = await getConfig(env);
  return (config && config.TIMEZONE) || 'Asia/Shanghai';
}

/**
 * 给结果中的 subscription 附加派生展示字段（nameParts / daysLeft），不落库。
 *
 * @param {any} result
 * @param {string} timezone
 */
function decorateResult(result, timezone) {
  if (result && result.subscription) {
    return { ...result, subscription: withDerivedFields(result.subscription, timezone) };
  }
  return result;
}

/**
 * 批量操作：对每个 id 复用单条逻辑，顺序执行（避免并发读改写 sub_index）。
 *
 * @param {Request} request
 * @param {any} env
 */
async function handleBatch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  const action = body && body.action;
  const rawIds = body && body.ids;
  if (!BATCH_ACTIONS.includes(action)) {
    return new Response(
      JSON.stringify({ success: false, message: `action 必须是 ${BATCH_ACTIONS.join(' / ')} 之一` }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return new Response(
      JSON.stringify({ success: false, message: 'ids 必须是非空数组' }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  /** @type {string[]} */
  const ids = [];
  for (const raw of rawIds) {
    const id = typeof raw === 'number' ? String(raw) : raw;
    if (typeof id !== 'string' || id.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, message: 'ids 中包含无效 id' }),
        { status: 400, headers: JSON_HEADERS }
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > BATCH_MAX_IDS) {
    return new Response(
      JSON.stringify({ success: false, message: `单次最多处理 ${BATCH_MAX_IDS} 条` }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const timezone = await getTimezone(env);
  const results = [];
  for (const id of ids) {
    let r;
    try {
      if (action === 'renew') {
        // 与 POST /subscriptions/:id/renew 空 body 完全一致：续 1 个周期，记录一条支付
        r = await manualRenewSubscription(id, env, {});
      } else if (action === 'enable' || action === 'disable') {
        r = await toggleSubscriptionStatus(id, action === 'enable', env);
      } else {
        r = await deleteSubscription(id, env);
      }
    } catch (err) {
      r = { success: false, message: err && err.message ? err.message : '操作失败' };
    }
    /** @type {any} */
    const item = { id, success: !!(r && r.success) };
    if (r && r.message) item.message = r.message;
    if (r && r.subscription) {
      item.subscription = withDerivedFields(r.subscription, timezone);
      item.expiryDate = r.subscription.expiryDate;
    }
    results.push(item);
  }
  const succeeded = results.filter((x) => x.success).length;
  return new Response(
    JSON.stringify({
      success: succeeded === results.length,
      action,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results
    }),
    { status: 200, headers: JSON_HEADERS }
  );
}

async function testSingleSubscriptionNotification(id, env) {
  try {
    const subscription = await getSubscription(id, env);
    if (!subscription) {
      return { success: false, message: '未找到该订阅' };
    }
    const config = await getConfig(env);

    const title = `手动测试通知: ${subscription.name}`;

    const showLunar = config.SHOW_LUNAR === true;
    let lunarExpiryText = '';

    if (showLunar) {
      const timezoneForLunar = config?.TIMEZONE || 'UTC';
      const expiryParts = getTimezoneDateParts(subscription.expiryDate, timezoneForLunar);
      const lunarExpiry = lunarCalendar.solar2lunar(expiryParts.year, expiryParts.month, expiryParts.day);
      lunarExpiryText = lunarExpiry ? ` (农历: ${lunarExpiry.fullStr})` : '';
    }

    const timezone = config?.TIMEZONE || 'UTC';
    const formattedExpiryDate = formatTimeInTimezone(new Date(subscription.expiryDate), timezone, 'date');
    const currentTime = formatTimeInTimezone(new Date(), timezone, 'datetime');

    const calendarType = subscription.useLunar ? '农历' : '公历';
    const autoRenewText = subscription.autoRenew ? '是' : '否';
    const formattedAmount = formatAmount(subscription.amount, subscription.currency || 'CNY');
    const amountText = formattedAmount ? `\n金额: ${formattedAmount}/周期` : '';

    const categoryText = subscription.category ? subscription.category : '未分类';

    const commonContent = `**订阅详情**
类型: ${subscription.customType || '其他'}${amountText}
分类: ${categoryText}
日历类型: ${calendarType}
到期日期: ${formattedExpiryDate}${lunarExpiryText}
自动续期: ${autoRenewText}
备注: ${subscription.notes || '无'}
发送时间: ${currentTime}
当前时区: ${formatTimezoneDisplay(timezone)}`;

    const tags = extractTagsFromSubscriptions([subscription]);
    const notifyResult = await sendNotificationToAllChannels(title, commonContent, config, '[手动测试]', {
      env, subId: id, ruleId: 'manual-test',
      metadata: { tags }
    });

    const attempted = notifyResult?.attempted || 0;
    const successCount = notifyResult?.successCount || 0;
    const failedCount = notifyResult?.failedCount || 0;

    if (attempted === 0) {
      return { success: false, message: '未启用任何通知渠道，请先在系统配置中开启至少一种通知方式' };
    }

    if (successCount === 0) {
      return { success: false, message: `测试通知发送失败（已尝试 ${attempted} 个渠道）` };
    }

    if (failedCount > 0) {
      return { success: true, message: `测试通知已发送：成功 ${successCount} 个，失败 ${failedCount} 个渠道` };
    }

    return { success: true, message: `测试通知发送成功（共 ${successCount} 个渠道）` };
  } catch (error) {
    console.error('[手动测试] 发送失败:', error);
    return { success: false, message: '发送时发生错误: ' + error.message };
  }
}

async function handleSubscriptions(request, env, path) {
  const method = request.method;

  if (path === '/subscriptions') {
    if (method === 'GET') {
      const subscriptions = await getAllSubscriptions(env);
      const timezone = await getTimezone(env);
      const now = new Date();
      const decorated = subscriptions.map((sub) => withDerivedFields(sub, timezone, now));
      return new Response(JSON.stringify(decorated), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'POST') {
      let subscription;
      try {
        subscription = stripDerivedFields(await request.json());
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await createSubscription(subscription, env);
      // 创建成功后写入提醒规则，并同步 legacy 提醒字段（列表展示依赖）
      if (result.success && result.subscription) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const incoming = Array.isArray(subscription.reminderRules)
            ? subscription.reminderRules
            : null;
          const rules = incoming && incoming.length > 0
            ? incoming.map(remindersRepo.normalizeRule)
            : remindersRepo.defaultPresetRules();
          await remindersRepo.replaceForSubscription(env, result.subscription.id, rules);
          await syncLegacyReminderFields(env, result.subscription.id, rules);
        } catch (err) {
          console.error('[subscriptions] 写入提醒规则失败（订阅本身已创建）:', err);
        }
      }
      return new Response(JSON.stringify(result), {
        status: result.success ? 201 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path === '/subscriptions/batch' && method === 'POST') {
    return handleBatch(request, env);
  }

  if (path.startsWith('/subscriptions/')) {
    const parts = path.split('/');
    const id = parts[2];

    if (parts[3] === 'toggle-status' && method === 'POST') {
      const body = await request.json();
      const result = await toggleSubscriptionStatus(id, body.isActive, env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (parts[3] === 'test-notify' && method === 'POST') {
      const result = await testSingleSubscriptionNotification(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'renew' && method === 'POST') {
      let options = {};
      try {
        const body = await request.json();
        options = body || {};
      } catch (e) {
        // empty
      }
      const result = await manualRenewSubscription(id, env, options);
      /** @type {any} */
      let payload = result;
      if (result.success && result.subscription) {
        payload = decorateResult(result, await getTimezone(env));
        payload.expiryDate = result.subscription.expiryDate; // 新到期日（顶层，方便前端直接取）
      }
      return new Response(JSON.stringify(payload), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(JSON.stringify({ success: false, message: '订阅不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, payments: subscription.paymentHistory || [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'DELETE') {
      const paymentId = parts[4];
      const result = await deletePaymentRecord(id, paymentId, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'PUT') {
      const paymentId = parts[4];
      const paymentData = await request.json();
      const result = await updatePaymentRecord(id, paymentId, paymentData, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(
          JSON.stringify({ success: false, message: '订阅不存在' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const timezone = await getTimezone(env);
      return new Response(JSON.stringify(withDerivedFields(subscription, timezone)), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'PUT') {
      let subscription;
      try {
        subscription = stripDerivedFields(await request.json());
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await updateSubscription(id, subscription, env);
      // 与创建路径对称：若 body 带 reminderRules 则整体替换并同步 legacy
      if (result.success && Array.isArray(subscription.reminderRules)) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const rules = subscription.reminderRules.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, rules);
          await syncLegacyReminderFields(env, id, rules);
        } catch (err) {
          console.error('[subscriptions] 更新提醒规则失败（订阅本体已更新）:', err);
        }
      }
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE') {
      const result = await deleteSubscription(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}

export { handleSubscriptions };
