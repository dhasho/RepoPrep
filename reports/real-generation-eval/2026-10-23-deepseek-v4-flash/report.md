# Real model public repository evaluation

- Mode: real-model-public-repositories
- Run: 86f91465-5ac3-4a70-8e5a-9b076bbbf1ab
- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash
- Status: complete
- Human review: pending

| Case | Variant | Questions | Requests | Input chars | Tokens | Alerts |
|---|---|---:|---:|---:|---:|---|
| mitt | generation | 20 | 1 | 26429 | 41894 | none |
| mitt | baseline | 20 | 1 | 8369 | 28290 | none |
| p-limit | generation | 20 | 1 | 51219 | 37099 | none |
| p-limit | baseline | 20 | 1 | 7325 | 26711 | known_fact_keyword_missing |
| schedule | generation | 20 | 1 | 174638 | 86659 | none |
| schedule | baseline | 20 | 2 | 29600 | 46295 | known_fact_keyword_missing |
| requests | generation | 20 | 1 | 218698 | 94781 | known_fact_keyword_missing |
| requests | baseline | 20 | 1 | 7884 | 29954 | none |

Keyword coverage records configured keyword matches; it does not measure factual accuracy. Human review remains pending.

## 源码事实复核

本次固定 4 个公开仓库提交，生产组和 README/目录树/扫描元信息对照组使用同一生成器、模型和题量要求。共 160 道主问题、9 次真实 HTTP 请求；schedule 对照组额外触发一次格式或结构修复。

模型：deepseek-v4-flash。服务商返回的实际用量合计：输入 165,768 tokens、输出 225,915 tokens、总计 391,683 tokens。输出 token 可能包含服务商的思考用量，不能直接解释成可见答案长度。

由 gpt-6-luna 按固定源码逐事实复核，再由主代理核对候选问题并剔除误报。两组各核对 28 条核心事实；复核文件以 runId 和全部 160 道题的 fingerprint 绑定本次输出。以下是代理辅助、非盲审的覆盖记录，不能换算成全部答案的事实正确率。

每格顺序：完整覆盖 / 部分覆盖 / 未覆盖 / 存在相反断言。

| 项目 | 分组 | 生产组 | README 对照组 |
|---|---|---|---|
| mitt | development | 6 / 0 / 0 / 0 | 6 / 0 / 0 / 0 |
| p-limit | development | 7 / 0 / 0 / 0 | 7 / 0 / 0 / 0 |
| schedule | development | 7 / 0 / 0 / 0 | 0 / 4 / 2 / 1 |
| requests | holdout | 3 / 2 / 2 / 1 | 4 / 2 / 1 / 1 |

合计生产组：23 / 2 / 2 / 1；对照组：17 / 6 / 3 / 2。

这些样本中，补充源码对 schedule 的核心事实覆盖帮助明显；Requests 的生产组仍出现 PreparedRequest 可变性、缓存流重读与解码方面的错误。增加上下文长度不能保证答案正确。

### 已核对的问题位置

以下是已发现的问题，不是穷尽清单；“表述不精确”与“错误断言”分别记录。合理的设计建议、明确的假设方案和未核对的外部依赖行为未作为错误计数。

- **mitt / generation / 第 18 题（表述不精确）**：第一个追问回答称 docs 可以和 bundle 并行执行。 该追问是在分析 docs 与 bundle 能否并行的可行性，理由本身合理；但回答没有区分可行的并行优化与当前脚本行为。固定 package.json 使用 `-p bundle -s docs`，当前 docs 阶段实际串行运行。 [固定源码](https://github.com/developit/mitt/blob/6b41670516ed8e8b738612f60491995470aa63b3/package.json#L24-L27)
- **mitt / baseline / 第 2 题（表述不精确）**：回答称每个工厂实例的状态天然隔离。 默认不传共享 Map 时，工厂会创建新 Map，实例隔离结论成立；但 mitt 也允许注入已有 Map，因此这句话若不加“默认”条件会过于绝对。Q3 随后已说明共享 Map 的情形。 [固定源码](https://github.com/developit/mitt/blob/6b41670516ed8e8b738612f60491995470aa63b3/src/index.ts#L46-L58)
- **mitt / baseline / 第 16 题（错误断言）**：最后一个追问回答称条件类型规则集中在一个签名里，避免写两个 emit 重载。 Emitter 接口实际声明两个 emit 重载：一个接收 payload，一个用条件类型允许省略 payload；条件重载没有消除这对签名。 [固定源码](https://github.com/developit/mitt/blob/6b41670516ed8e8b738612f60491995470aa63b3/src/index.ts#L35-L39)
- **p-limit / generation / 第 7 题（表述不精确）**：“如果反过来，极端情况下多个 resumeNext 可能都看到未更新的 activeCount。” 该并发风险不能由当前实现推出：queueItem.run 只 resolve 内部 Promise，run 由后续 then 微任务调用；dequeue/run 的同步栈中没有用户任务可重入调用 resumeNext。源码能确认先占槽这一顺序，但不支持“反过来会超发”的具体推断。 [固定源码](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/index.js#L19-L24)
- **p-limit / baseline / 第 2 题（表述不精确）**：“在 finally 中递减 activeCount 并取出下一个任务继续跑。” 答案已标注这是根据 README/常见实现的推断；与当前版本源码结构不符（源码是 try/catch 后调用 next，而非 finally），但两者描述的成功/失败释放槽位行为一致，因此不作为已证实的功能失效。 [固定源码](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/index.js#L32-L48)
- **p-limit / baseline / 第 5 题（表述不精确）**：“activeCount 表示已经调用 fn 但尚未 settle 的 Promise 数。” activeCount 在 resumeNext 中先递增，之后 queueItem.run 才通过 Promise.then 调用 run/fn，所以它短暂包含已占槽但 fn 尚未调用的任务。test.js 的异步测试先断言 activeCount，再修改 value，最终任务读到修改后的值，直接体现了该时序。 [固定源码](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/index.js#L19-L24)
- **schedule / generation / 第 8 题（表述不精确）**：until()把所有datetime.datetime或datetime.time输入都归一为naive的cancel_after。 代码对datetime.datetime直接赋值，对datetime.time用combine；输入若带tzinfo不会被去掉，随后与naive datetime.now()比较会抛TypeError。回答应限定为naive时间输入。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L605-L612)
- **schedule / generation / 第 14 题（错误断言）**：latest小于interval时抛ScheduleValueError；测试捕获ScheduleError是因为前者继承后者。 层级方向是ScheduleValueError继承ScheduleError，但该分支直接抛基类ScheduleError。测试的assertRaises(ScheduleError)捕获的就是这个基类异常，主回答的异常类型和追问对测试通过原因的解释均不准确。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L53-L65)
- **schedule / baseline / 第 2 题（错误断言）**：`.seconds`会设置单位与间隔；`.do()`返回的Job可调用`job.cancel()`。 interval由Scheduler.every(interval)传入Job构造器，seconds属性只设置unit。源码提供Scheduler.cancel_job(job)和模块级cancel_job(job)，Job没有cancel()方法。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L162-L170)
- **schedule / baseline / 第 3 题（表述不精确）**：Job保存一个独立的取消标记。 Job字段中有cancel_after截止时间，但没有独立的已取消标记；主动取消是从Scheduler.jobs移除该Job。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L227-L255)
- **schedule / baseline / 第 5 题（错误断言）**：`run_pending()`通常返回本轮执行的Job数量。 Scheduler.run_pending明确标注返回None，函数只筛选、排序到期任务并执行，没有返回运行数量。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L89-L101)
- **schedule / baseline / 第 6 题（错误断言）**：`CancelJob`会被`Job.run`捕获并用于任务自取消。 CancelJob不是异常。Job.run将任务函数返回值原样作为ret处理；Scheduler._run_job再判断返回值是否为CancelJob类或实例并移除任务。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L71-L75)
- **schedule / baseline / 第 11 题（错误断言）**：`next_run`必须保存为aware datetime或UTC，不能保存为naive本地时间。 当前实现明确将有指定时区计算得到的next_run转换回系统本地时区并去掉tzinfo，以兼容既有API；should_run再与本地naive datetime.now()比较。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L667-L672)
- **schedule / baseline / 第 14 题（错误断言）**：`CancelJob`是控制流异常，`Job.run`会捕获它；外部也可调用`job.cancel()`。 CancelJob是普通哨兵类，任务返回它后由Scheduler._run_job处理；Job没有cancel()方法，外部取消应调用Scheduler.cancel_job(job)或模块级cancel_job(job)。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py#L71-L75)
- **schedule / baseline / 第 19 题（表述不精确）**：`setup.cfg`/`pyproject.toml`配置项目的flake8或pytest。 这个固定版本的setup.cfg仅包含mypy的files=schedule；pyproject.toml声明构建后端、项目元数据和可选timezone依赖，没有flake8或pytest配置。 [固定源码](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/setup.cfg#L1-L2)
- **requests / generation / 第 1 题（错误断言）**：第一个追问把 PreparedRequest 描述为“不可变语义对象”。 PreparedRequest 的源码文档明确称其为 fully mutable；它是已准备、可发送的请求对象，但不是不可变对象。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/models.py#L378-L397)
- **requests / generation / 第 14 题（错误断言）**：主回答声称访问 .content 后再迭代会抛 StreamConsumedError。 访问 .content 会把数据缓存为 bytes；此后 iter_content 检查到已消费缓存时使用 iter_slices 重放。StreamConsumedError 只在已消费且 _content 仍是 bool 哨兵时抛出。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/models.py#L958-L977)
- **requests / generation / 第 14 题（错误断言）**：第一个追问称 decode_unicode=True 且没有响应编码时通常回退 UTF-8。 stream_decode_response_unicode 在 encoding 为 None 时直接 yield 原 iterator 的 bytes 并返回；不会进行 UTF-8 解码。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/utils.py#L594-L610)
- **requests / baseline / 第 1 题（表述不精确）**：主回答称 api.py 函数入口会“构造或复用 Session”。 该固定版本的 api.request 每次都在 with 块中新建并关闭 Session；复用 Session 是调用方显式使用 Session 的方式，不是顶层 api 函数的行为。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/api.py#L67-L71)
- **requests / baseline / 第 5 题（错误断言）**：主回答将 prepare_auth 排在 prepare_body 之前。 PreparedRequest.prepare 的实际顺序是 prepare_body、prepare_auth、prepare_hooks；auth 需要在主体与其他字段准备后处理。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/models.py#L439-L451)
- **requests / baseline / 第 7 题（错误断言）**：主回答称 resolve_redirects 读取 Response.next 来获得 Location 目标。 resolve_redirects 直接调用 get_redirect_target(resp)；Response.next 返回 _next，并在不自动跟随重定向时由 Session.send 单独填充。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/sessions.py#L186-L205)
- **requests / baseline / 第 7 题（表述不精确）**：主回答把 301、302、303 都概括为非 HEAD 方法通常改成 GET。 此实现对 303 和 302 的非 HEAD 方法改成 GET；301 仅在原方法为 POST 时改成 GET，不能概括为所有非 HEAD 方法。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/sessions.py#L370-L392)
- **requests / baseline / 第 8 题（错误断言）**：主回答称 default_hooks 返回 EventHook 对象，且存在 EventHook 类。 源码没有 EventHook 类；default_hooks 返回以 response 为键、值为空列表的字典，dispatch_hook 接受 callable 或 iterable 并顺序执行。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/hooks.py#L22-L48)
- **requests / baseline / 第 9 题（错误断言）**：主回答及首个追问都称 data 与 json 同时传入会抛 ValueError。 prepare_body 仅在 data 为假值且 json 非 None 时编码 JSON；data 非空时使用 data，不会因两者同时传入而抛 ValueError。现有测试也明确验证 json 不覆盖 data。 [固定源码](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/models.py#L576-L600)

### 使用边界

- 每组只运行一次，4 个知名库不是有代表性的大样本；模型也可能已记住这些公开实现。
- requests 是本批唯一 holdout；本次只记录结果，没有用它修改提示词或生成策略。
- 关键词覆盖、结构契约和题量通过不代表事实准确；人工盲审仍为 pending，未把代理复核导入为人工评分。
- 事实清单位于 RepoPrep 的 real-corpus 目录，未进入被扫描仓库或模型请求。

逐事实依据和所有题目指纹见同目录 `assistant-review-*.json`，完整问题、答案、追问、调用统计和源码哈希见 `report.json`。
