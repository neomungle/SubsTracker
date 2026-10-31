// @ts-check
/**
 * UI 重设计：页面骨架 / 品牌资源 / 关键交互挂钩的回归测试
 */
import { describe, expect, it, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import {
  loginPage,
  adminPage,
  configPage,
  dashboardPage,
  notifyLogsPage,
  renderHeader
} from '../../src/views/pages.js';
import { ICON_PATHS } from '../../src/views/icons.js';

const PAGES = {
  login: loginPage,
  admin: adminPage,
  config: configPage,
  dashboard: dashboardPage(),
  notifyLogs: notifyLogsPage
};

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

describe('品牌资源路由（无需登录）', () => {
  beforeEach(clearKv);

  it('GET /favicon.svg 返回 SVG', async () => {
    const res = await app.request('/favicon.svg', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('GET /favicon.ico 返回 32px PNG', async () => {
    const res = await app.request('/favicon.ico', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('GET /apple-touch-icon.png 返回 PNG', async () => {
    const res = await app.request('/apple-touch-icon.png', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it('品牌路由不触发迁移写入 KV', async () => {
    await app.request('/favicon.ico', {}, env);
    const list = await env.SUBSCRIPTIONS_KV.list();
    expect(list.keys.length).toBe(0);
  });
});

describe('页面骨架', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    it(`${name}: 注入主题资源、favicon 与图标雪碧图，不再依赖 Font Awesome / Tailwind 2`, () => {
      expect(html).not.toContain('${themeResources}');
      expect(html).toContain('rel="icon"');
      expect(html).toContain('href="/favicon.svg"');
      expect(html).toContain('rel="apple-touch-icon"');
      expect(html).toContain('id="i-plus"');
      expect(html).not.toMatch(/font-awesome|tailwindcss\/2\.2\.19|tailwindcss@2/);
      expect(html).not.toMatch(/class="fa[srb]? /);
      expect(html).not.toContain('<!--APP_HEADER');
      expect(html).not.toContain('<!--ICON_SPRITE');
    });

    it(`${name}: 引用的图标都存在于雪碧图`, () => {
      const used = new Set(Array.from(html.matchAll(/#i-([a-z-]+)/g), (m) => m[1]));
      for (const icon of used) {
        expect(ICON_PATHS, `missing icon ${icon}`).toHaveProperty(icon);
      }
    });
  }

  it('登录页显示 Logo 与 SubsTracker 字标', () => {
    expect(loginPage).toContain('class="brand-mark"');
    expect(loginPage).toContain('SubsTracker');
    expect(loginPage).toContain('id="loginForm"');
  });

  it('顶栏为三列网格：Logo / 居中导航 / 操作，且当前页高亮', () => {
    const header = renderHeader('config');
    expect(header).toContain('class="topbar-inner"');
    const nav = header.slice(header.indexOf('desktop-nav'), header.indexOf('top-actions'));
    expect(nav.match(/class="navlink/g)).toHaveLength(4);
    expect(nav).toMatch(/class="navlink active" href="\/admin\/config"/);
    expect(header).toContain('id="systemTimeDisplay"');
    expect(header).toContain('href="/api/logout"');
    expect(header).toContain('class="bottomnav"');
    for (const label of ['订阅列表', '仪表盘', '通知历史', '系统配置']) {
      expect(nav).toContain(label);
    }
  });
});

describe('订阅列表页新功能挂钩', () => {
  it('概览统计条读取 /api/dashboard/stats 的 expiryStats / estimatedAnnualSpend', () => {
    expect(adminPage).toContain("apiFetch('/api/dashboard/stats')");
    expect(adminPage).toContain('expiryStats');
    expect(adminPage).toContain('estimatedAnnualSpend');
    for (const id of ['statExpired', 'statSoon7', 'statSoon30', 'statAnnual']) {
      expect(adminPage).toContain(`id="${id}"`);
    }
  });

  it('按紧急程度分组，已停用默认折叠', () => {
    for (const title of ['已过期', '7 天内', '30 天内', '以后', '已停用']) {
      expect(adminPage).toContain(`title: '${title}'`);
    }
    expect(adminPage).toMatch(/collapsedGroups = \{ disabled: true \}/);
  });

  it('快捷续期使用空 body POST /renew，批量操作调用 /api/subscriptions/batch', () => {
    expect(adminPage).toMatch(/'\/renew', \{ method: 'POST' \}\)/);
    expect(adminPage).toContain("apiFetch('/api/subscriptions/batch'");
    expect(adminPage).toContain('id="bulkBar"');
  });

  it('保留原有表单与弹窗元素 ID', () => {
    const ids = [
      'subscriptionModal', 'subscriptionForm', 'modalTitle', 'closeModal', 'cancelBtn', 'name', 'customType',
      'customTypeDropdown', 'category', 'categoryDropdown', 'currency', 'amount', 'subscriptionMode', 'showLunar',
      'useLunar', 'endOfMonth', 'startDate', 'startDatePicker', 'startDateCalendar', 'expiryDate', 'expiryDatePicker',
      'expiryDateCalendar', 'periodValue', 'periodUnit', 'calculateExpiryBtn', 'reminderRulesContainer',
      'reminderRulesAddBtn', 'reminderRulesPresetBtn', 'reminderUnit', 'reminderValue', 'isActive', 'autoRenew',
      'notes', 'subscriptionId', 'searchKeyword', 'clearSearch', 'categoryFilter', 'statusFilter', 'modeFilter',
      'listShowLunar', 'addSubscriptionBtn', 'subscriptionsBody', 'toast-container'
    ];
    for (const id of ids) expect(adminPage, id).toContain(`id="${id}"`);
    for (const id of ['renewFormModal', 'renewForm', 'confirmRenewBtn', 'paymentHistoryModal', 'editPaymentModal']) {
      expect(adminPage, id).toContain(`id="${id}"`);
    }
  });
});

describe('系统配置页', () => {
  it('每个通知渠道是独立卡片，启用开关即 enabledNotifiers 复选框', () => {
    const channels = ['telegram', 'notifyx', 'webhook', 'wechatbot', 'email', 'bark', 'gotify', 'ntfy', 'serverchan', 'pushplus', 'wpush'];
    for (const ch of channels) {
      expect(configPage).toContain(`data-channel="${ch}"`);
      expect(configPage).toMatch(new RegExp(`name="enabledNotifiers" value="${ch}" class="switch"`));
    }
    expect(configPage).not.toMatch(/class="tag[ "]/);
  });

  it('恢复模式为分段单选：合并默认，覆盖带警告', () => {
    expect(configPage).toMatch(/<input type="radio" name="importMode" value="merge" checked>/);
    expect(configPage).toMatch(/class="seg-danger"><input type="radio" name="importMode" value="replace">/);
    expect(configPage).toContain('id="importReplaceWarning"');
    // 分段控件位于导入按钮之前
    expect(configPage.indexOf('name="importMode"')).toBeLessThan(configPage.indexOf('id="importBackupBtn"'));
  });

  it('时区与浏览器不一致时显示提示', () => {
    expect(configPage).toContain('id="tzMismatchBanner"');
    expect(configPage).toContain('resolvedOptions().timeZone');
  });
});
