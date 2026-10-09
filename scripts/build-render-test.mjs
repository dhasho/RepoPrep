// 用仓库自带的 esbuild 把需要做组件级断言的组件打包成 CJS，
// 供 node --test 运行：静态断言用 react-dom/server 渲染，
// 生命周期断言（卸载触发 cancelExplain 等 effect 副作用）用 jsdom 真实挂载。
//
// 为什么需要它：纯函数单测验证不了"组件是否真的用了正确的输入"。
// 例如 issue #11 里 ResultPage 把 buildQuestionNumbers(result.sections) 误写成
// filtered、issue #12 里弹卡是否接上了控制器，都只有在渲染真实组件时才能发现。
//
// 两个打包上的要点：
// 1. 产物必须是 CJS：react / react-dom 被标为 external，必须由 Node 自己解析
//    （打成 IIFE 时 esbuild 的 require 垫片会报 "Dynamic require of react is not supported"）。
// 2. react-dom 被替换成 scripts/portal-shim.js：createPortal 直通返回 children，
//    其余导出转发给真实 react-dom。这只影响测试产物，不碰生产代码。
//
// 用法（见 package.json 的 test:renderer）：
//   node scripts/build-render-test.mjs
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const shimPath = path.join(projectRoot, 'scripts', 'portal-shim.js')

/** react-dom → portal-shim；shim 自身对 react-dom 的 require 不拦截，转发给真实实现 */
const portalShim = {
  name: 'portal-shim',
  setup(build) {
    build.onResolve({ filter: /^react-dom$/ }, (args) => {
      if (args.importer && path.resolve(args.importer) === shimPath) return undefined
      return { path: shimPath }
    })
  }
}

const entries = [
  { name: 'result-page', entry: 'src/pages/ResultPage.tsx' },
  { name: 'term-popover', entry: 'src/components/TermPopover.tsx' }
]

for (const { name, entry } of entries) {
  await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: 'node20',
    outfile: path.join(projectRoot, '.render-test', `${name}.cjs`),
    logLevel: 'error',
    alias: {
      '@shared': path.join(projectRoot, 'shared'),
      '@': path.join(projectRoot, 'src')
    },
    plugins: [portalShim],
    // 只保留 react / react-dom 为外部依赖：它们同时被测试进程使用，
    // 打包两份 React 实例会让 hooks 失效。
    external: ['react', 'react-dom', 'react/jsx-runtime']
  })
  console.log(`[build-render-test] ${name} <- ${entry}`)
}
