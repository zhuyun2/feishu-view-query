/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 构建入口（平台强制：Webpack 5 + @lark-opdev/block-bitable-webpack-utils）。
 *
 * ⚠️ 飞书平台约束：上传要求产物由 Webpack 构建，并安装官方 utils 语义化注入插件运行时
 *    （bridge 注入、project.config.json / index.json 产出、devServer 调试中间件等）。
 *    禁止替换为 Vite/Rollup。
 *
 * ⚠️ 官方 utils 的路径约定（0.1.7 已核对 dist 源码）：
 *    - `path.resolve(process.cwd(), '../app.json')` —— app.json 在 **上一级目录（app-dir）**；
 *    - `path.resolve(process.cwd(),  'block.json')` —— block.json 在 **当前目录（view-dir）**；
 *    - `path.resolve(process.cwd(), './debug.json')` —— 当前目录（可选）。
 *    对应 `opdev create ${app-dir}/${view-dir}` 的目录约定（技术方案 §13 亦已注明
 *    「CLI 在上层目录找 app.json、当前层找 block.json」）。`npm run start|build` 的工作目录即
 *    本目录（package.json 所在），故 `../app.json` = 本目录的上一级。
 *
 *    `ensureAppJsonAtParent()` 在实例化官方插件前，把本目录的 app.json **同步**到上一级
 *    （仅当缺失或内容不一致时写入），使本仓库「plugin/ 自包含」且开箱可用。
 *
 * ⚠️ 官方 utils 以 `process.env.NODE_ENV === 'production'` 判定「产出上传物料 / 打开调试文档」，
 *    而 `webpack --mode production` **不会**设置该环境变量，故此处显式对齐，避免生产构建误走调试分支。
 */
const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');

/**
 * 官方 utils 读取 app.json 的位置为上一级目录（app-dir）。
 * 将本目录的 app.json 同步到上一级：目标缺失或内容不一致时写入；否则不动。
 * 若本目录没有 app.json（官方布局：app.json 已在 app-dir），则不做任何处理。
 */
function ensureAppJsonAtParent() {
  const parentApp = path.resolve(__dirname, '..', 'app.json');
  const localApp = path.resolve(__dirname, 'app.json');
  try {
    if (!fs.existsSync(localApp)) return;
    const localContent = fs.readFileSync(localApp, 'utf-8');
    const parentExists = fs.existsSync(parentApp);
    const parentContent = parentExists ? fs.readFileSync(parentApp, 'utf-8') : '';
    if (parentExists && parentContent === localContent) return;
    fs.writeFileSync(parentApp, localContent);
    // eslint-disable-next-line no-console
    console.info(`[webpack] 官方 utils 需在上一级读取 app.json：已同步 ${localApp} → ${parentApp}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[webpack] 无法在上一级准备 app.json（构建仍会继续）：', err && err.message);
  }
}

/**
 * 官方 Webpack 工具。不同版本导出名可能不同，这里做特性探测，避免因命名差异直接构建失败。
 * 若未安装（例如网络受限的本地演练），降级为纯 Webpack 构建并给出显式告警——
 * 该产物缺少官方运行时注入，**不可上传**，仅用于本地类型/逻辑演练。
 */
let larkUtils = null;
try {
  // eslint-disable-next-line global-require
  larkUtils = require('@lark-opdev/block-bitable-webpack-utils');
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn(
    '[webpack] 未能加载 @lark-opdev/block-bitable-webpack-utils（构建产物不可上传）：',
    err && err.message,
  );
}

/**
 * 从 utils 中解析官方 Webpack 插件。
 * `@lark-opdev/block-bitable-webpack-utils@0.1.7` 导出的是**插件类** `BitableAppWebpackPlugin`
 * （`class`，必须 `new` 实例化；其构造函数会读取 app.json / block.json）。
 */
function resolveLarkPlugins() {
  if (!larkUtils) return [];
  const candidates = [
    larkUtils.BitableAppWebpackPlugin,
    larkUtils.BlockBitableWebpackPlugin,
    larkUtils.WebpackPlugin,
    larkUtils.default,
    larkUtils,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // 构造函数 / class：必须用 new 实例化（class 也有 Function.prototype.apply，不能据此判为实例）。
    if (typeof candidate === 'function') {
      try {
        return [new candidate()];
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[webpack] 实例化官方插件失败：', err && err.message);
        continue;
      }
    }
    // 已是插件实例（普通对象，含 apply）。
    if (typeof candidate.apply === 'function') return [candidate];
  }
  return [];
}

/** 官方 devServer 调试中间件（webpack 5 走 setupMiddlewares）。 */
function resolveOpdevMiddleware() {
  if (!larkUtils || typeof larkUtils.opdevMiddleware !== 'function') return null;
  return larkUtils.opdevMiddleware;
}

module.exports = (_env, argv) => {
  const isProd = (argv && argv.mode) === 'production';

  // 官方 utils 以 NODE_ENV 判定生产/调试分支；webpack --mode 不会设置它，需显式对齐。
  if (isProd) {
    process.env.NODE_ENV = 'production';
  } else if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
  }

  // 必须在实例化官方插件之前，确保 app.json 位于官方期望的上一级目录。
  ensureAppJsonAtParent();

  const larkPlugins = resolveLarkPlugins();
  const opdevMiddleware = isProd ? null : resolveOpdevMiddleware();

  return {
    mode: isProd ? 'production' : 'development',
    entry: path.resolve(__dirname, 'src/main.tsx'),
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.[contenthash].js',
      chunkFilename: '[name].[contenthash].chunk.js',
      assetModuleFilename: 'assets/[hash][ext][query]',
      clean: true,
      // 插件运行于宿主 iframe 内、由平台托管静态资源，使用相对路径。
      publicPath: '',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader',
              options: {
                // 类型检查由 `npm run typecheck` 独立负责，构建只做转译以提速。
                transpileOnly: true,
              },
            },
          ],
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader', 'postcss-loader'],
        },
        {
          test: /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot)$/,
          type: 'asset',
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        inject: 'body',
      }),
      // 官方 utils 注入插件（已成功解析时）。若 utils 缺失，此数组为空——
      // 构建仍可完成，但产物缺少平台运行时注入，**不可上传**（见 README 说明）。
      ...larkPlugins,
    ],
    devServer: {
      port: 9000,
      host: '0.0.0.0',
      hot: true,
      allowedHosts: 'all',
      // 宿主为跨源 iframe，需放开 CORS 与 iframe 嵌入。
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      client: {
        overlay: { errors: true, warnings: false },
      },
      // 官方调试中间件：注入 blockit 路由、CSP 等，配合 `opdev login` 使用。
      setupMiddlewares: (middlewares, devServer) => {
        if (opdevMiddleware) {
          try {
            middlewares.push(opdevMiddleware(devServer));
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              '[webpack] 挂载 opdevMiddleware 失败（不影响静态调试）：',
              err && err.message,
            );
          }
        }
        return middlewares;
      },
    },
    optimization: {
      minimize: isProd,
    },
    devtool: isProd ? false : 'source-map',
    stats: 'minimal',
    performance: {
      hints: false,
    },
  };
};
