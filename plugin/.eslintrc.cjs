module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
  },
  // node_modules_trash_*/ 是一次性 node_modules 备份目录（用户明确拒绝删除），
  // 其内含旧依赖自带的 .eslintrc（如 deep-eql 引用了不存在的 "strict/es5"），
  // 会让 `eslint .` 直接报 config 缺失而非 lint 问题。此处仅忽略、不删除。
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'node_modules_trash_*/',
    '_npmcache/',
    '*.config.js',
    '*.config.ts',
    '.eslintrc.cjs',
  ],
};
