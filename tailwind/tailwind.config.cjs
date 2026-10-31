/** 由 src/views/theme-resources.html 原 Play CDN 配置迁移而来；生成 public/css/tailwind.css */
function v(name) { return 'rgb(var(--c-' + name + ') / <alpha-value>)'; }
function scale(bg, line, solid) {
  return { 50: v(bg), 100: v(bg), 200: v(line), 300: v(line), 400: v(solid), 500: v(solid), 600: v(solid), 700: v(solid), 800: v(solid), 900: v(solid) };
}
const neutral = { 50: v('card2'), 100: v('paper'), 200: v('line'), 300: v('line'), 400: v('tertiary'), 500: v('muted'), 600: v('muted'), 700: v('ink'), 800: v('ink'), 900: v('ink') };
const ink = { 50: v('card2'), 100: v('paper'), 200: v('line'), 300: v('line'), 400: v('ink'), 500: v('ink'), 600: v('ink'), 700: v('ink'), 800: v('ink'), 900: v('ink') };
const red = scale('redbg', 'redline', 'red');
const amber = scale('amberbg', 'amberline', 'amber');
const green = scale('greenbg', 'greenline', 'green');
const blue = scale('bluebg', 'blueline', 'blue');
module.exports = {
  content: ['./src/views/**/*.{html,js}', './public/js/**/*.js'],
  darkMode: 'class',
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        white: v('card'), black: v('ink'),
        gray: neutral, slate: neutral, zinc: neutral, neutral: neutral, stone: neutral,
        indigo: ink, violet: ink,
        red, rose: red, pink: red,
        yellow: amber, amber, orange: amber,
        green, emerald: green, teal: green, lime: green,
        blue, sky: blue, cyan: blue, purple: blue,
        paper: v('paper'), card: v('card'), line: v('line'), ink: v('ink'), muted: v('muted')
      }
    }
  }
};
