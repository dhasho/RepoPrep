// 让 `node --test` 直跑 TypeScript 源码时能解析两类打包器风格 import：
//   1. 别名 `@shared/*`（由 electron.vite.config.ts 的 resolve.alias 提供）
//   2. 省略扩展名的相对导入（`./llm`、`./scanner`），Node 原生要求显式 .ts
//
// 生产代码里 electron/services/* 大量使用这两种写法，而它们只在打包器下有效。
// 既有的直跑测试因此都刻意避开了这些模块；本文件补上这层解析，
// 使得端到端测试可以直接调用真实的 generator / context-builder，而不必改动生产 import。
//
// 用法（见 package.json 的 test:question-budget）：
//   node --experimental-strip-types --import ./tests/register-shared-alias.mjs --test ...
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { registerHooks } from 'node:module'

const projectRoot = path.resolve(import.meta.dirname, '..')
const sharedDir = path.join(projectRoot, 'shared')

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 1) @shared/* 别名
    if (specifier === '@shared' || specifier.startsWith('@shared/')) {
      const sub = specifier === '@shared' ? 'index' : specifier.slice('@shared/'.length)
      const target = path.join(sharedDir, `${sub}.ts`)
      if (existsSync(target)) {
        return { url: pathToFileURL(target).href, shortCircuit: true }
      }
    }

    // 2) 相对导入省略扩展名 → 补 .ts（仅当目标文件确实存在时才改写）
    if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier)) {
      if (context.parentURL && context.parentURL.startsWith('file:')) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL))
        const candidate = path.resolve(parentDir, `${specifier}.ts`)
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
    }

    return nextResolve(specifier, context)
  }
})
