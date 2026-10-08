// 用仓库自带的 esbuild 把结果页打包成可在 Node 里渲染的 IIFE，
// 供 src/lib/question-numbering.test.ts 做**组件级**断言。
//
// 为什么需要它：纯函数单测只能验证序号映射本身；如果 ResultPage 里把
// `buildQuestionNumbers(result.sections)` 误写成 `filtered`（正是 issue #11 的缺陷类别），
// 纯函数测试仍然全绿。这里渲染真实组件才能抓到那类回归。
//
// 用法（见 package.json 的 test:renderer，会先执行本脚本）：
//   node scripts/build-render-test.mjs <输出文件>
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(projectRoot, 'src', 'pages', 'ResultPage.tsx')
const outfile = process.argv[2]
if (!outfile) {
  console.error('用法: node scripts/build-render-test.mjs <输出文件>')
  process.exit(1)
}

// 复用 electron.vite.config.ts 里的别名：@shared -> shared，@ -> src
await build({
  entryPoints: [entry],
  bundle: true,
  // 必须是 cjs：react / react-dom 被标为 external，IIFE 格式无法处理它们的 require()
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  target: 'node20',
  outfile,
  logLevel: 'error',
  alias: {
    '@shared': path.join(projectRoot, 'shared'),
    '@': path.join(projectRoot, 'src')
  },
  // 只保留 react / react-dom 为外部依赖：它们同时被测试进程使用，
  // 打包两份 React 实例会让 hooks 失效。
  external: ['react', 'react-dom', 'react/jsx-runtime']
})

// 供调用方确认产物可用
const require = createRequire(import.meta.url)
require.resolve('react-dom/server')
console.log(`[build-render-test] ${path.relative(projectRoot, outfile)}`)
