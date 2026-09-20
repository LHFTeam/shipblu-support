// No `@type {import('postcss-load-config').Config}` annotation: that package
// is not installed, and `allowJs` is false so tsc never reads this file — the
// annotation checked nothing and named a dependency we do not have.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
