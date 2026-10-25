# API Key 存储与 IPC 边界

## 存储方式

API Key 以 Electron `safeStorage`（异步 OS 加密）产生的版本化密文保存在 `settings.json`（schema 2）及其受管理恢复副本中。只有在主进程执行生成、术语解释、连接测试或模型列表请求时才解密。OS 凭据服务不可用时按失败关闭处理：拒绝写入新密钥和密钥解密，不回退明文；Linux 的 `basic_text` 和无法识别的后端不算受保护存储。

## IPC 边界

- `settings:get` 只返回模型配置元数据、`hasApiKey` 和凭据状态，永不返回明文或密文。renderer 的 `hasApiKey` 等声明不用于授权判断。
- 保存设置时按 profile 显式携带 `keep`、`replace` 或 `clear` 意图；模型探测/连接测试可以携带用户输入的新密钥，或按 profile ID 引用已保存密钥。
- 引用已保存密钥时，主进程校验目标端点与规范等价的已保存端点、有效接口协议均相同；更换端点或协议必须先替换或清除旧密钥。缺省协议按 OpenAI 处理，`anthropic` 使用 Claude Messages 格式。

## 设置界面行为

- 已存储凭据的密码输入框为空；设置页展示密钥是受保护、OS 凭据不可用还是等待迁移，并让替换与清除操作显式化。
- 在有已存密钥的 profile 上清空刚输入的替换密钥会回到 `keep`；删除已存密钥必须走显式 clear。
- 用户输入的替换密钥短暂存在于 renderer 草稿和对应 IPC 请求中；保存确认且权威 `settings:get` 回读后草稿被清除（除非请求期间用户又改了该密钥）。已保存密钥永不回填到输入框或掩码成可复用值。

## 旧明文迁移

旧版明文设置在主进程首次解析私有凭据或保存设置之前迁移。迁移检查主设置文件、受管理的 `.bak`/`.corrupt` 副本及 store 精确管理的临时文件名；可解析的旧设置被加密，读取有界。无法安全解析的受管快照保留为 OS 加密的二进制归档，标记 `RepoPrep encrypted settings archive v1`——标记只识别格式、不认证内容，必须解密成功才算恢复。

每个文件替换都是原子的，但多个文件之间没有事务：中途失败可能留下已转换与待转换副本并存，此时报告 migration-pending，现有字节仍可恢复，后续解析凭据、保存设置或受控恢复时自动续跑；只要还有受管理的明文副本就不报告成功。

## 威胁范围

Windows 上 Electron `safeStorage` 使用当前 Windows 用户的 DPAPI。这能防“只拿到 settings 文件的人”，不能防与同一用户同权限运行的恶意程序、被攻陷的应用进程，或一个合法请求主进程使用凭据的 renderer。它是静态保护边界，不是对已登录账户或活动会话被攻陷的防御；把密文复制到其他 Windows 用户或设备不保证可解密，也不构成可移植备份。

## 验证

验证只用合成密钥和临时目录。`npm run test:ipc` 覆盖存储迁移、恢复、IPC 校验与 fake-crypto 边界测试。`npm run test:native-credentials` 先构建，再在隔离临时 `appData`/`sessionData`/`userData` 中运行真实 `safeStorage` 适配器和设置服务：保存、无明文检查、公开回读、legacy 与 Anthropic profile 的私有存储往返、跨协议凭据复用拒绝全部通过后才输出 `VERDICT NATIVE-CREDENTIAL-OK`。它证明本机当前平台的原生存储链路，不证明真实模型调用或跨账户/设备可移植性。
