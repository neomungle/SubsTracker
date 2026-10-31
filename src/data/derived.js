// @ts-check
/**
 * 订阅的"派生展示字段"（只在 API 响应中出现，永不持久化）。
 *
 * - nameParts: 把 name 按空白 / 半角逗号 / 全角逗号 / 半角分号 / 全角分号 / Tab 拆分，
 *              去首尾空白并去掉空项。适合一条订阅里写了多个域名、多个号码的场景。
 * - daysLeft : 距到期日的整天数（按配置时区的自然日计算；今天到期为 0，已过期为负数）。
 *
 * 写入路径（POST / PUT / 批量）必须调用 stripDerivedFields，避免客户端把这些字段回传后被存进 KV。
 */
import { getDaysBetween } from '../core/time.js';

/** 所有派生字段名（只读、不落库） */
export const DERIVED_FIELDS = Object.freeze(['nameParts', 'daysLeft']);

const NAME_SPLIT_REGEX = /[\s,，;；\t]+/;

/**
 * @param {unknown} name
 * @returns {string[]}
 */
export function computeNameParts(name) {
  if (typeof name !== 'string') return [];
  return name
    .split(NAME_SPLIT_REGEX)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/**
 * @param {unknown} expiryDate
 * @param {string} timezone
 * @param {Date} [now]
 * @returns {number | null} 无效日期时返回 null
 */
export function computeDaysLeft(expiryDate, timezone, now = new Date()) {
  if (expiryDate == null || expiryDate === '') return null;
  const d = new Date(/** @type {any} */ (expiryDate));
  if (Number.isNaN(d.getTime())) return null;
  return getDaysBetween(now, d, timezone);
}

/**
 * 返回附带派生字段的新对象（不修改入参）。
 *
 * @template {Record<string, any>} T
 * @param {T} sub
 * @param {string} timezone
 * @param {Date} [now]
 * @returns {T & { nameParts: string[], daysLeft: number | null }}
 */
export function withDerivedFields(sub, timezone, now = new Date()) {
  if (!sub || typeof sub !== 'object') return /** @type {any} */ (sub);
  return {
    ...sub,
    nameParts: computeNameParts(sub.name),
    daysLeft: computeDaysLeft(sub.expiryDate, timezone, now)
  };
}

/**
 * 去掉客户端回传的派生字段（返回浅拷贝，不修改入参）。
 *
 * @template T
 * @param {T} body
 * @returns {T}
 */
export function stripDerivedFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  /** @type {Record<string, any>} */
  const copy = { ...body };
  for (const key of DERIVED_FIELDS) delete copy[key];
  return /** @type {T} */ (copy);
}
