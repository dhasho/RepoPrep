# 升级到 1.0.0

1.0.0 引入不兼容的数据与 IPC 变化。公开 `settings:get` 现在只返回配置元数据、`hasApiKey` 和凭据状态，不再返回 API Key；保存操作采用 `keep`、`replace` 或 `clear` 意图，界面显式提交该意图。密钥现以 Electron `safeStorage` 的 OS 加密形式写入 schema 2 设置文件。新版本会读取旧结果；旧版程序无法读取 schema 2 凭据，也无法读取含新字段（例如 `sourceEvidence`）的新版结果。

旧版明文设置会在主进程首次解析已保存私有凭据之前，或保存设置之前触发安全迁移。迁移逐个转换主设置文件及受管理的恢复副本；无法安全完成时报告 `migration-pending` 并保留尚未转换的恢复副本，稍后再次解析凭据、保存设置或执行受控恢复时可重试。每个文件替换是原子的，但主文件、备份和损坏快照之间没有跨文件事务，因此中途失败可能留下已转换与待转换副本并存的状态。迁移细节见 [credential-security.md](credential-security.md)。

在首次打开 1.0.0 前，建议先退出应用并复制 RepoPrep 的整个用户数据目录，至少保留 `settings.json` 及其受管理的 `.bak`、`.corrupt` 恢复文件。迁移开始后如需回退旧版，应先关闭应用并从升级前副本恢复用户数据；旧版二进制无法安全读取已迁移的 schema 2 密钥或新版结果文件。

Windows 上 Electron `safeStorage` 使用当前 Windows 用户的 DPAPI。拿到设置文件但没有当前用户访问权的人不能据此解密密钥；同一用户权限下运行的恶意程序仍可能访问应用数据或请求应用使用密钥。复制这些密文到另一 Windows 用户或设备不保证可解密，也不构成可移植备份。威胁范围见 [credential-security.md](credential-security.md)。

旧版生成结果仍由 1.0.0 读取。新版生成结果可能带有界定的来源证据字段；旧版程序不支持这些字段，因此不要用旧版二进制打开新版结果。来源证据能证明被引用的脱敏片段曾提供给模型，不证明答案事实正确，详见 [source-evidence.md](source-evidence.md)。

离线生成评测报告与人工复核的范围和限制见 [generation-evaluation.md](generation-evaluation.md)。
