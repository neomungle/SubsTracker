// 页面模板 - 使用 text import 避免嵌套模板字面量问题
import themeResourcesHtml from './theme-resources.html';
import loginPageHtml from './loginPage.html';
import adminPageHtml from './adminPage.html';
import configPageHtml from './configPage.html';
import dashboardPageHtml from './dashboardPage.html';
import notifyLogsPageHtml from './notifyLogsPage.html';
import { buildIconSprite } from './icons.js';

const ICON_SPRITE = buildIconSprite();

/** 主题色自适应的 Logo 标识（与 brand/logo.svg 同形，颜色跟随 token） */
const LOGO_MARK =
  '<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">' +
  '<rect class="bm-bg" width="64" height="64" rx="16"/>' +
  '<path class="bm-fg" d="M45.5 22.5A16 16 0 1 0 48 32" fill="none" stroke-width="4.5" stroke-linecap="round"/>' +
  '<path class="bm-fg" d="M37.5 22.5H45.5V14.5" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path class="bm-hand" d="M32 24v8.5l5.5 3.5" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const NAV_ITEMS = [
  { key: 'list', href: '/admin', label: '订阅列表', short: '订阅', icon: 'list' },
  { key: 'dashboard', href: '/admin/dashboard', label: '仪表盘', short: '仪表盘', icon: 'chart-line' },
  { key: 'logs', href: '/admin/notify-logs', label: '通知历史', short: '通知', icon: 'history' },
  { key: 'config', href: '/admin/config', label: '系统配置', short: '配置', icon: 'settings' }
];

function svgIcon(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}

/**
 * 顶栏（三列网格：Logo 左 / 导航居中 / 操作右）+ 移动端底部标签栏
 * @param {string} active
 */
function renderHeader(active) {
  const links = NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    return (
      '<a class="navlink' + (isActive ? ' active' : '') + '" href="' + item.href + '"' +
      (isActive ? ' aria-current="page"' : '') + '>' + item.label + '</a>'
    );
  }).join('');
  const tabs = NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    return (
      '<a class="' + (isActive ? 'active' : '') + '" href="' + item.href + '"' +
      (isActive ? ' aria-current="page"' : '') + '>' + svgIcon(item.icon) + '<span>' + item.short + '</span></a>'
    );
  }).join('');
  return (
    '<header class="topbar">' +
      '<div class="topbar-inner">' +
        '<a href="/admin" class="brand" aria-label="SubsTracker 首页">' + LOGO_MARK + '<span>SubsTracker</span></a>' +
        '<nav class="desktop-nav" aria-label="主导航">' + links + '</nav>' +
        '<div class="top-actions">' +
          '<span id="systemTimeDisplay" class="server-time" title="系统时区当前时间"></span>' +
          '<button type="button" class="icon-btn theme-toggle" onclick="toggleTheme()" aria-label="切换浅色 / 深色主题" title="切换主题">' +
            svgIcon('moon', 'i-moon') + svgIcon('sun', 'i-sun') +
          '</button>' +
          '<a href="/api/logout" class="icon-btn" aria-label="退出登录" title="退出登录">' + svgIcon('log-out') + '</a>' +
        '</div>' +
      '</div>' +
    '</header>' +
    '<nav class="bottomnav" aria-label="底部导航">' + tabs + '</nav>'
  );
}

// themeResources 需要注入到每个页面模板中；APP_HEADER / ICON_SPRITE / LOGO_MARK 为页面骨架占位
function injectTheme(html) {
  return html
    .replace(/\$\{themeResources\}/g, () => themeResourcesHtml)
    .replace(/<!--\s*ICON_SPRITE\s*-->/g, () => ICON_SPRITE)
    .replace(/<!--\s*LOGO_MARK\s*-->/g, () => LOGO_MARK)
    .replace(/<!--\s*APP_HEADER:(\w+)\s*-->/g, (_m, key) => renderHeader(key));
}

const loginPage = injectTheme(loginPageHtml);
const adminPage = injectTheme(adminPageHtml);
const configPage = injectTheme(configPageHtml);
const notifyLogsPage = injectTheme(notifyLogsPageHtml);

function dashboardPage() {
  return injectTheme(dashboardPageHtml);
}

export { loginPage, adminPage, configPage, dashboardPage, notifyLogsPage, renderHeader, injectTheme };
