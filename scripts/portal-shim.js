// createPortal 的测试替身：把弹卡内容直通渲染（静态渲染没有 DOM 可挂，
// jsdom 挂载测试则让内容落在容器内便于断言）。其余 react-dom 导出原样转发
// 给真实实现 —— require('react-dom') 在打包时不被 portal-shim 插件拦截
// （见 scripts/build-render-test.mjs），运行时由 Node 解析到真实包。
// 生产代码不受影响：本文件只在测试打包产物中被使用。
const actual = require('react-dom')

module.exports = {
  ...actual,
  createPortal: (children) => children
}
