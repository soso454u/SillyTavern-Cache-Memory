# 接续说明（2026-11-25，v1.27.40）

用户反馈截图中的「第未知层」「尚未生成 / 记录不存在」与最近3层正文省略提示，要求继续维护并提交推送。基于e997f9f；远端main与本地起点一致。仅凭截图无法判定摘要从未生成、接口未配置还是保存记录缺失，不应声称恢复了用户设备上的记忆或修好了真实模型接口。

根因：renderOverview把内部floor0用真假值判为「未知」，异常明细和问题分类未使用开场显示偏移；Rolling说明还保留旧版开场豁免描述。现在独立开场显示第1层并标明开场白，普通回复顺延；概览缺失CP／Long范围映射显示，首段涵盖开场，实际存储范围不改。真正没有合法floor的未匹配记录使用null并显示「楼层未定位」，不再混同floor0。缺失摘要显示「尚未生成摘要，可补全」，失败记录仍显示实际错误，提供一键补全、连接测试与生成日志入口。Rolling说明明确开场计入上限，缺摘要旧正文仍按上限省略。

另一个问题是historyInterceptor预补全的错误状态随即被applyHistorySelection覆盖，只剩正文省略警告。把本轮completion结果／捕获的异常传入省略提示，保留最后一条具体原因并给出处理入口，不新增持久日志或请求。fillMissingMemories错误文本中的楼层同样映射显示；currentRange／计划／保存索引不改。不修改补全算法、请求数、付费重试预算、保存逻辑、已有记忆或正文。全部客户端模块URL及版本统一1.27.40，Store v6不变。

验证：83项summary-health、ui-context、injection-runtime、opening-memory、injection-completion、fill-all-memory、rolling-history定向测试通过；新增8项测试并加强1项运行期断言，覆盖截图缺口／连续编号、开场失败／无开场、未定位记录与0层区分、聚合显示范围、正常记忆、预补全返回错误与抛出异常都保留原因、开场补全错误显示1而内部仍0。npm run check与git diff --check通过。只用合成消息及假模型，没有浏览器／手机实机验证、真实模型调用、私人文件读取或全套测试。私人目录「临时记忆查看，不准上传仓库」仍不提交。

# 接续说明（2026-11-23，v1.27.39）

用户指出开场完整原文一直发送、开场摘要又不在CACHE_MEMORY里，明确要求开场白摘要与普通楼层相同，遵守隐藏规则。对提供的私人JSONL本地只读核对，确认开场摘要已保存且原文匹配，但旧快照无对应summary-story；没有修改文件或把角色、剧情、导出文件、凭据放入仓库。测试全部独立合成。

根因两处：injection.currentInjectionBlocks排除内部floor0；history-handoff为开场保留特殊豁免并排除在Rolling原文计数外。现在Rolling／短正文用getSummaryEntries包含开场；Rolling将开场（user/char均适用）按普通故事层纳入N层原文窗口及cap，未确认覆盖／空快照也遵守同一上限；系统与工具规则不改。开场仍在窗口内不提前注入独立摘要；离开窗口后floor0 Summary生成summary-story块，传入sourceContentFingerprint证明开场覆盖；CP／Long带匹配openingContentFingerprint时退出独立块。publishedOpeningCoverage接受该Summary证明，且窗口内原文保持；没有常驻开场块。短正文按同一来源指纹／状态校验将开场替换为摘要，受保护媒体及来源无法核对时沿用该模式的保留规则；frozen prefix字节不改，替换只在请求副本。

summaryStoryBlock增加可选显示偏移，块start/end内部不变，文本标签按开场1、普通2…显示。当前注入新发布的CP、Long、角色表和状态截至楼层同样映射；index从实际chat传summaryFloorOffset，快照记录供短正文尾部复用，旧冻结快照仍按原边界刷新。没有修改持久Summary／CP／Long记录或索引，无新增模型请求路径。原Rolling预补全继续使用已有开场摘要；缺摘要仍走既有补全和错误提示。模块／CSS URL及版本1.27.39，Store v6不变。

最小验证：63项Rolling、history-handoff、opening、真实index假宿主注入及设备加载定向回归通过；新增N=1/3/5、user/char开场窗口内外、只出现一份summary、CP/Long接管退出、标签映射、短正文替换与冻结前缀不变。旧测试将“开场永久豁免”断言改为用户新要求，旧阶段模式未覆盖时保留原文的回归继续通过。另用用户文件副本在内存中模拟，确认已有开场摘要注入、长开场原文退出、最近正文数量保持；输出仅结构统计，真实文件与原存储未修改。没有真实模型、私人聊天在线操作或浏览器预览，未跑全套；语法与diff检查。以下旧文中开场原文永久保护或不计正文窗口的说明被本次用户指令取代。

# 接续说明（2026-11-23，v1.27.38）

用户先反馈select多选不清楚，明确要求列表右侧「查看原文」，又要求聊天选择与截图中的楼层摘要／角色资料编辑区重新排版，展开编辑用小按钮、主题和谐。随后追加开场摘要，先说第0层，又撤回为「开场白显示第1层，其余顺延」；以最后要求为准。当前版本尚未提交前的这些调整一起发布1.27.38。

功能区改为圆形选择标记与已选文字的聊天卡片，计数、全选／清空选择、右侧独立查看原文。后台运行锁选择，查看仍可用。previewChat仅用原生兼容get接口按需读当前消息name/text，纯文本显示、20条分页，不读其他聊天内容、不生成／保存／切前台；只持有当前预览，取消与state引用检查防过期结果，关闭设置／预览、换角色、刷新列表和卸载释放内容。

共享editorField统一短字段双列／手机单列，长字段右侧小号展开编辑。紧凑区最长136px；展开走原showPluginDialog expandedEditor，约55vh／480px正文区，15px字号与1.9行距、固定底部操作。应用只更新源控件草稿并dispatch input，最后原保存流程落盘；取消不改，检查原控件连接、值、chatId和销毁状态防旧草稿覆盖。摘要四个旧字段折叠，已有内容默认展开；角色条件／关联人物／持续类型在补充信息，历史证据折叠，保存和新增取消同一操作栏。未改摘要格式／保存语义。

opening-source.getSummaryEntries在现有正常回复索引前加独立内部floor0的开场条目，getAssistantMessages不改。displayFloor/sourceFloor把有独立开场的界面编号映射为1、2…，不存在独立开场时不平移；生成首条普通回复不会重复识别开场。MemoryStore同步／选择／清理与Summary按ID生成支持开场；fillMissingMemories和后台补全包含它。开场摘要不提取独立表格状态，原CP／Long继续处理开场事实。没有强制改写旧楼层ID、已存CP范围、注入序列或首段聚合规则。开场修改／删除可使后续时间线失效；floor0失效同时重置branch编号避免遗漏历史空洞。摘要列表升序，开场第1层在前。批量、源楼层、截断与branch输入转回内部索引；branch支持只留开场，recent保留原正常楼层的映射／覆盖校验。trimChatMemory内部-1代表用户填0清空，内部0代表只保留显示第1层开场。Store仍v6，客户端与CSS URL统一1.27.38。

最小验证：124项定向Node检查通过，涵盖选择／预览／展开草稿隔离、开场独立生成及只含开场、原CP/Long开场继承、编号映射、branch／批量、原UI与运行期的定向回归；语法和diff检查。另隔离Chromium使用真实UI方法与合成消息核对桌面双列、390px手机单列、右侧原文按钮、无横向溢出、展开窗口及底部操作可见、应用／取消及预览不选中。仅合成数据与假模型，没有访问用户私人聊天、付费模型或原生TT实机，未跑全套。临时预览页已关闭。依AGENTS默认提交推送，私人目录不提交。

# 接续说明（2026-11-23，v1.27.37）

用户要求继续维护并提交推送：桌面／手机固定窗口尺寸只可拖动，修复删楼／roll后旧记忆污染后文，跨角色聊天后台总结并各自保存，无记忆平行聊天，清空后从现有正文第1层重新计数，以ST为主兼容TT；明确只做最小必要验证。后续追问确认保留1–5删除6以后，旧记忆也应清理；进一步要求处理已存在的混入记忆。

MemoryStore.discardTimelineFrom 在明确变化楼层起清理 Summary 后缀及 endFloor 覆盖后续的 CP／Long，记删除 tombstones，早期KEEP从保留摘要重建，手动状态重新建立，丢弃旧注入快照。timeline changed 是所有注入模式的立即刷新边界。index 在 native delete／edit／swipe 及生成结束取消旧任务并执行；删除事件同样检测user删除引起的索引移动。retireTimeline 同时限制平行线继承编号，并保存branch header／Swipe副本，避免旧继承边界继续跳层。refreshChatState 在完整历史加载和服务器核对后检查已知正文／user指纹以及超出时间线的聚合；不猜测缺来源记录。新增「记忆只保留到第N层」修复入口，确认前后核对聊天、记忆digest和完整原文，确认保存后报告；0走清空及重置计层。保留的原文日后可以再总结，已经生成到正文的错误剧情不自动修改。

prepareChatBranch 新 empty 模式仅复制所选前缀正文，createEmptyStore 独立chatId，清除所有branch floor／Swipe旧标记，安全metadata白名单，不继承KEEP／状态／快照。clearCurrentChat(chat)重置编号；UI经context.saveChat保存消息中的编号变化，flush后才报告成功。当前仍有一层char时下一条是2，而不是26。保留原其他分支模式。

新 background-memory.js 为所选角色的一份／多份聊天顺序补全三层，使用独立 Store／Summarizer／Persistence 及原生聊天文件读写；不切换前台、不调用全局模型取消、不发布前台注入。启动时冻结模型设置与凭证namespace，标记内部请求，避免用户切换配置导致旧URL配新Key。每条替换沿用确认保存流程；后台原生保存读最新header保留其他扩展metadata，核对完整正文／integrity及native memory基线，非force写入后读回；权威库可用时CAS提交后镜像到原生文件，最终再确认镜像。目标被打开、停止、原文改变时停止，成功记录保留；失败显示准确错误，不把未补齐报告完成。任务只在页面存活期运行，无自动恢复后台队列，当前只列角色聊天，群聊仍用原前台操作。ST原生无原子CAS，不能声称完全消除跨窗口极短写竞态。

窗口移除主窗和子窗缩放节点／事件／CSS，保留固定设备布局和可见视口防遮挡；标题鼠标／触摸拖动均可，viewport变化重置偏移防标题跑出。功能区增第六tab。

TT依据当前公开 docs/API/Chat.md 与 FrontendHostContract.md：完整索引数组可能有null历史槽。host-chat.hydrateHostChat用公开current.handle().history分页读取，检查分页进度、完整长度、chat identity和每个已加载正文／角色，再只填null槽，不覆盖已有草稿、不偏移绝对索引。读取失败停止，Summarizer拒绝不完整历史。ST正常完整数组不额外请求。

最小验证：79项相关定向Node回归及npm run check、git diff --check通过；合成数据／假模型，未调用真实付费接口或操作私人聊天，未跑全套，未做浏览器预览或原生TT／iOS实机验证。详见本次提交测试。私人目录「临时记忆查看，不准上传仓库」保留且绝不提交。版本和全部客户端模块URL统一1.27.37，Store仍v6。以下旧说明服从本段和用户新要求（尤其历史上“roll只删单层且CP/Long不变”“窗口可缩放”已被本次要求取代）。

# 接续说明（2026-11-20，v1.27.36）

用户要求修复手机窗口底部遮挡，并明确要求最小必要验证。根因是 bindDialogViewport 固定使用 layoutViewport／100lvh 最大高度且不随 visualViewport 改变。手机现在用当前 visualViewport 的尺寸和偏移设置 overlay 与 --cm-dialog-height，resize／scroll 后合帧更新；桌面仍保持原锚点。CSS 保留一个主滚动面与底部24px间距，移除旧键盘高度 padding，子窗通过现有 max-height 限定在新可见范围。此要求取代旧说明中“手机键盘变化也绝不改变窗口几何”的规则。

最小验证：窗口相关24项Node测试通过，修改文件语法与diff检查；隔离Chromium手机尺寸合成页面先复现底部不可达，再核对修复后不同可见高度、键盘输入框和子窗最后字段／确认栏可见，没有横向溢出。不是iOS实机验证，未调用模型／触碰私人聊天。新增 ui-window-viewport-fixture.html 可复查，未跑全量业务测试。

# 接续说明（v1.27.35）

用户要求生成日志包含实际发送和模型返回的全部内容。API 客户端在每次实际 ST 代理发送前记录完整 payload，消费响应时记录原始 JSON／SSE 文本及安全响应头，成功时另给已收到的 reasoning／正文，错误时保留可见响应体与诊断。SSE 在原 reader 上旁观收集，不复制请求、不额外读取 DONE 后的数据；诊断观察者失败不影响生成。参数重发／流式回退分别记录，摘要重试保留每次更改后的系统提示词。

日志只在 UI 当前页面最近六次生成中，切聊天清空；无 localStorage／记忆／同步新增持久化。移除日志的 cleanGeneratedResponse 与 12000 字符裁剪，通过 textContent 显示原文，新增纯文本下载。密钥、认证头、CSRF、Cookie 与常见凭证字段在进入 UI 前脱敏；不改变真实 payload／响应与业务校验。模型推理仅记录接口明确返回的字段。只能观察插件→ST 的请求和 ST 返回的数据，不能声称捕获后端实际改写或供应商内部内容。新回归覆盖长请求／响应尾部、额外 choices／usage、SSE 分片／错误／DONE、所有实际重发、拒答与格式重试、脱敏、控制台不输出完整内容、六次上限／聊天隔离／literal markup 和下载。

# 接续说明（2026-11-19，v1.27.34）

用户提供三份 SELENE 小说预设，要求合并成独立摘要模型身份；后续明确要求去掉笼统的“非露骨表述”限制，保留场景中有事实作用的原话与动作。本轮仅更新 DEFAULT_GLOBAL_PROMPT 和菜单标签为“默认摘要身份（Selene）”。身份说明任务是整理已有虚构小说，采用第三人称和原阶段格式，保留历史后果、人物认知、独立动机、意愿、关键行为及核心短引句；长句可准确转述，合并无信息重复。没有复制预设中的指令越权、强制成年或继续写小说要求。年龄、关系、事件性质依据实际来源。

默认选择动态使用新身份；空白／自定义文本保持，不迁移三层可见模板、不改预算／模型参数／拒答拦截、不重写旧记忆。新增实际 Summary→CP→Long 假接口请求测试，确认身份只在每个系统提示词前出现一次、不写入来源或记忆。仍不能保证上游模型不拒答。以下历史说明服从当前版本。

# 接续说明（2026-11-19，v1.27.33）

修复 v1.27.32 放宽 Summary 正文接收后，中文拒答／检索失败被存为已冻结剧情的问题。response-quality.js 独立提供服务回复识别，response-cleanup 的结构化、纯文本、JSON、XML 与正文标签路径共用检查。不得只要非空就认作剧情，也不能把人物道歉、引语或有来源对白一概删除。接口可能仍返回拒答，本地修复只能拒绝把错误当剧情，不能保证上游输出。

旧自动摘要仅在标题和人物均为空／占位词、Event 仅含明确服务错误时作只读 invalid-response 分类，人工编辑与带人物／标题的历史剧情保留。isUsableMemory 排除这些来源，summaryNeedsUpdate 和一键补全会重生；历史批处理的 missing-failed／failed 同样处理它们。卡片和统计不再显示成功冻结。原记录直到新结果确认保存才替换，失败或保存未确认不清空；重生时不继承错误记录的 stateChanges。冻结注入保持原边界，用户可用“重新注入”显式刷新。

新增合成回归覆盖截图两种通用错误措辞、三层生成、格式入口、真实道歉／对白、旧记录不变／待补全／投影隔离、保存确认与结果复用、持续拒答不覆盖，以及默认历史批处理。不调用真实模型，不提交私人聊天。以下历史说明服从当前版本。

# 接续说明（2026-11-02，v1.27.14）

用户指出仅摘要assistant会丢失user直接确立的时间跳跃、年龄、关系背景及单方感情／知情差，要求接续维护。本轮基于abb604c，仍在 /private/tmp/cache-memory-retry-fix 检出；用户提供的私人剧情和图片未加入仓库，回归改用独立合成角色及普通工作／合作场景。

根因确认：summarizeEntry原输入只用extractSummarySource(entry.message.mes)，user文本没有进入模型，也不能成为Changes证据。summary-source新增summaryUserSource，收集该assistant之前、上一条普通assistant之后的连续user输入，跳过系统、工具、小系统／narrator，不跨过前一assistant收集历史，也不读其后的新user输入。JSON数据栏目CURRENT_USER_INPUT附在原assistant来源后、旧背景前；原assistant过滤规则保持，user事实不被assistant自定义标签过滤掉。仍每个assistant楼层一份Summary，一次既有任务及原预算，不增加用户楼层或独立生成任务。

generationPrompt只在Summary追加来源契约：明确已成立的user背景／时间推进／年龄／身份关系／感情和认知差即使回复没复述也需合并；不把一方关系写成双方一致，压缩重复过程为因果留字数。区别角色说法、未来请求、愿望、条件和写作／格式／越权指令，不执行来源数据中的指令，不把它们写成已发生剧情。CP／Long提示词不变，用户设定经Summary传下去。普通模式不增加Changes输出标签；表格仍只在原勾选时出现。

证据源为filtered assistant加本轮user原文，Changes可引用任一直接来源的连续原文，不用旧摘要或拼接消息；有明确时间地点时优先assistant，缺失才用user，绝对日期不推算。新Summary保存userSourceFingerprint（内容与作者，不依赖时间戳/导入ID），加到可选summaryVersion字段，旧无字段的s2版本保持原算法，不升Store版本。队列key和inFlight key包含user指纹，前后和提交前校验user原文变化，旧请求不得吞掉新版；正文相同但user改了时不继承旧stateChanges。

summaryNeedsUpdate识别已记录user来源发生明确内容变化，自动更新、缺失计划和注入补齐会重做该对应Summary；失败时旧有效记录直到确认替换都保留，CP不使用待修复摘要。rolling覆盖检查保留已知user来源已改、尚未修复的原文；failed／未冻结摘要不能证明覆盖。CP／Long的来源断言加入user指纹，使用同一份chat快照计算，避免千层合成加载器在每条记录重复重建整个聊天。旧无user字段的冻结Summary保持兼容，不因升级全量重做；已有漏项需用户重新生成对应Summary，并通过对应CP／Long记录的原重新生成入口更新已存在的聚合。validateDependencies当前为no-op，不能假设“更新需处理的阶段记忆”会自动列出这种旧聚合。

验证：npm run check、npm test共661项、git diff --check通过。新增14项覆盖单轮连续user来源、系统／工具与跨轮隔离、JSON标记指令作为数据、双模式同一事实契约、过滤和元数据、生成中user修改及第二请求不被吞掉、下次注入修复、旧冻结兼容、导入元数据变化不重生成、user证据和旧状态清除、改动原文保留、Summary→CP→Long三次原任务传播及预算不变、修复失败不使用旧Summary生成CP。原千层连续性回归通过；真实模型输出质量仍需使用方观察，测试用假接口不证明模型绝不遗漏。版本和模块URL统一1.27.14，旧自定义模板与输出预算保留。

以下历史说明服从当前版本及最新用户要求。

# 接续说明（2026-11-02，v1.27.13）

用户追加明确要求：每次注入时检查截图里的 Summary／CP／Long “已生成／应有”，不满就自动重试补全，不要依赖新楼层或再点全部补全。本轮基于4836f7c；仍在 /private/tmp/cache-memory-retry-fix 临时检出中维护，原外置盘工作目录未挂载。

MemorySummarizer.completeBeforeInjection 对当前聊天及 contextRevision 只保留一个运行期 Promise，并发入口共用；等待既有摘要队列后重新扫描完整 getMissingMemoryPlan，缺口走现有 fillMissingMemories，每条保存确认后返回。不要把完整 fill 入 summarizer 队列，它的各条记录会再次入队而造成死锁。已有手动补齐任务 aggregateDeferrals>0 时不竞争开批次；齐全时无模型、无存储修改。用户本次要求覆盖关闭 autoSummarize 后的实际注入，仍检查补全；enabled／independentApi 关闭或 injectionMode=none 则跳过。失败留下待处理项，下一次注入重试；没有定时器或无限循环。

index 的 generate_interceptor 改 async，正常／Swipe／regenerate／continue 发主请求前 await 补全，再发布 rolling 投影并筛选该次临时 coreChat。核对官方 SillyTavern release/public/scripts/extensions.js 的 runGenerationInterceptors 已 await 各拦截器，abort(true) 支持立即终止；events.js 提供 GENERATION_STOPPED，绑定取消该轮预补全。停止生成、卸载、聊天切换和 source 变化取消过期请求；队列等待可被立即中断。来源保护包含开场、user／assistant 全文指纹与楼层，逐条进度也校验；不改存储聊天或其顺序。仍有非取消类失败时沿用已确认可用记忆，未覆盖原文按原覆盖检查保留。

只在实际生成拦截和用户点击“重新注入”入口做模型补全，不放在同步 updateInjection、store.onChange、服务器读回或界面渲染回调，否则补全保存会递归触发新付费任务。手动按钮新增 prepareInjection 回调，等待后再重新注入，未补齐显示 warning。清理、编辑等内部快照更新仍保持原行为。quiet 后台生成不触发预补全。Strict Cache 原边界和模型提示词／预算／重试间隔未改，版本和客户端URL统一1.27.13。

验证：npm run check、npm test共647项、git diff --check全通过。新增17项包括154层152/154+29/30+2/3补到齐全；完整记忆反复注入零请求；并发共享；不增加楼层也能下一轮恢复；关闭autoSummarize但仍按用户要求注入补全；等待旧摘要不重复；队列取消／正文、开场、用户输入变化；冲突和活跃历史批次不竞争；手动按钮等待及准确warning。完整index运行期测试使用真实Store、Summarizer、Persistence及合成ST环境，验证先保存Summary→CP→Long再发布并过滤当前prompt、原chat不变、原生停止取消、持续错误保留缺口原文、quiet零请求、等候中用户输入变化不发过期主请求。原设备同步测试等待async拦截器并保留只读断言。未连接真实模型或操作在线私人聊天；不代表原生酒馆实机运行验证。

以下历史说明服从当前版本及最新用户要求。

# 接续说明（2026-11-02，v1.27.12）

本轮用户要求修复截图中的“Summary 响应缺少有效剧情字段”及自动更新停滞，并提交上传 GitHub。基于 main 39420c4，在 /private/tmp/cache-memory-retry-fix 检出处理；原 /Volumes/Soivt39 工作目录当前未挂载，未修改用户私人聊天。

根因：重试只包围 complete 请求，响应清理和字段校验在循环外，INVALID_MEMORY_RESPONSE 不重试；自动总结只做最新楼层，旧失败和缺口阻断 CP／Long。completeWithRetry 现在包含验证回调，网络、内容校验和空响应共用 2／5／10 秒三次额外尝试，只缓存已验证结果。SAVE_UNCONFIRMED 保留结果供后续保存重试，不重复模型生成；明确输出截断不自动重试。已知栏目允许标题／加粗／全角括号／同一行正文，以及有效 Event 缺少 SUMMARY 外层标记；空字段、拒绝、错误和思考仍拒绝写入。

自动事件传 recoverPending 和运行期取消信号。串行处理最新层，再补已有摘要最早楼层到当前层之间的缺失／失败项，最后继续 CP／Long；可用旧记忆不重做。新安装聊天不从第1层大规模回溯。单层本轮仍失败则留待下次自动更新，不让旧层阻塞最新摘要。一键全部补全对耗尽预算的暂时性失败继续其他楼层与区间；缺少依赖的 CP／Long 暂留，认证、来源变化及保存问题仍停止。没有增加定时器或无限循环，不改提示词、字数、注入策略及保存事务。

验证：npm run check、npm test 共630项、git diff --check 通过。新增16项合成回归，包括截图153层的107／150／153缺口恢复并补9 CP和1 Long、旧层持续失败不影响最新层及下次恢复、三阶段共享重试预算、三阶段未确认保存复用结果、格式偏差及空响应、取消／聊天／来源变化、认证和保存网络错误停止。旧测试中若干假Long响应缺剧情却只按记录数误当成功，改成有效STORY_ARC并新增frozen断言；持续失败测试使用假等待，Long重试次数断言改为4。未请求真实模型或操作在线私人聊天。版本与客户端模块URL统一1.27.12，Store版本不变。

以下历史说明服从当前版本及最新用户要求。

# 接续说明（2026-10-10，v1.22.12）

本轮首先按用户要求修复模型接口体验，随后用户明确增加全局提示词、Long 中文分栏、楼层入口和就地编辑范围。连接测试移除强制 temperature=0，沿用正常 complete 参数。Key 停止输入 700ms 或失焦/change 时保存；空白不清除。浏览器按规范接口地址保存独立 Key/model，旧全局 Key 只绑定当前一个地址，没有新增多配置管理器。先输入 Key 再填首个地址也保留并保存。模型列表通过原 ST status 代理，400ms 防抖、按地址/密钥版本单次自动尝试、请求合并及过期结果保护；无聊天生成试探，手动刷新/模型输入保留，失败不清空。真实仓库只有单一独立接口编辑器；主模型的 apiCacheConnections 是缓存策略映射，不承载独立接口凭证，未修改。

提示词顶部新增折叠的全局提示词，栏内先放空白/默认破限/自定义选择，再放输入框。默认破限逐字使用用户文本；自定义切换模式仍保留，空白不发送。仅给 Summary/CP/Long 的系统提示词添加一次前缀，不进入连接测试和模型列表，不改三阶段算法及输出预算。Long 识别已有 CURRENT_TRACKED_STATE 和 CP 风格栏目，中文卡片分别展示/编辑；未知/重复栏目及前言仍保留原文回退，不改私人记忆或重新生成历史。

每条消息的入口居中、文字可点开关，去掉原生和主题伪元素箭头，入口/正文/编辑框/按钮读取 SmartThemeBodyColor、SmartThemeBorderColor、SmartThemeBlurTintColor 等。消息编辑就在楼层下面完成，共享原摘要编辑保存通路和校验标记；保存前确认聊天、消息正文和摘要未变，防止 Swipe/并发更改覆盖。普通刷新保留输入节点与焦点，消息或整个 #chat 重绘后自动恢复入口、展开和草稿。聊天子树 MutationObserver 在自身 DOM 写入时断开、按帧合并宿主变动；原 body observer 仅补接被替换的 #chat，文档事件委托避免丢失操作。销毁取消监听与帧。没有迁移 TT 数据库、引入 Rust API 或改变存储；参考 TT 当前 API Migration 文档中 getContext().chat 仍为完整数组/绝对索引，不按早期窗口说明盲改索引。

验证：npm run check、npm test 共 293 项和 git diff --check 通过。新增 11 项覆盖 Temperature、浏览器凭证/模型隔离与迁移、空白保护、先 Key 后地址、防抖/失败/过期模型列表、全局提示词三阶段、Long 扩展栏目无损、就地编辑与消息/摘要/聊天变化保护。另 test/ui-message-fixture.html 以纯合成数据在桌面和 390px 手机各通过 11 项检查：居中无箭头、九字段就地保存/取消、重绘/容器替换、草稿/焦点、禁用、防自循环、主题变化和无横向溢出。独立浏览器还验证自动模型列表仅 status 请求和显式连接测试 Thinking/temperature=1，全局选项保留自定义文本与布局。未连接真实模型或修改私人聊天；未在原生 Tauri 运行时实机验证。临时预览及合成 localStorage 项验证后清理。

# 接续说明（2026-10-10，v1.22.11）

本轮按用户截图仅调整长期记忆展示与编辑、分类按钮顺序。Long Memory 的现有 LONG_MEMORY / UPDATED_FACTS / RETIRED_FACTS 用阶段记忆相同的分块卡片样式显示；点击编辑按三个现有栏目就地填写，保存/取消沿用原管理器事件与保存通路。带额外栏目、前言、重复栏目或旧纯文本的自定义格式完整显示并使用原文编辑，避免重建时丢内容。分类顺序为概览、楼层摘要、长期事实、KEEP、未解决事项、角色状态、阶段记忆、长期记忆。

新 Long 编辑接入 updateAggregate；主动保存时同步正文与事实投影，未修改的事实保留 ID 和证据，不重新验证未改动的历史行；单独保存的 stateId 状态及 continuityState 保留，无改动保存不重建 factUpdates。只对用户主动编辑生效，生成、注入、Strict Cache、冻结边界、Claude 缓存、Token 预算及 Summary 统计不改。版本与客户端模块 URL 更新 1.22.11，Store v6 不变。

验证：npm run check、npm test 共 282 项及 git diff --check 通过。新增回归覆盖标准/旧/自定义格式无损处理、编辑保存与展开状态、事实投影同步、稳定事实 ID、独立状态和历史更新保留、未验证的新更新不采纳。独立浏览器用合成数据检查桌面分块、保存/取消、手机三个编辑框和旧格式回退、分类顺序与换行；无私人聊天或真实模型请求。临时预览仅提供公开代码与合成测试页，验证后停止。

# 接续说明（2026-10-10，v1.22.10）

用户两份实际注入不同，已确认第一份（含旧待领取、旧新数字并存及新增 KEEP）是主动重新注入后的结果。原 JSON 与第二份没有相同旧值，不能只看旧文件判断无问题。私人文本仅本地核对，合成回归不提交私人剧情。

active-state 的 threadKey 加入新手任务外壳，匹配当前栏目也识别裸名/任务前缀/括号外壳。attribute 仅规范已确认的“/红字数值”显示别名，不合并其他斜杠字段。保留最早 ID、按有效增量更新当前值，旧 orphaned 增量不能覆盖有效状态；完成/失败/取消不会被自动进度复活，人工纠错照旧。Long 只读取原 continuityState 中严格的“已结束 人物 · 任务：结果 (completed/failed/cancelled，历史结果)”行作为缺失 Summary 结算的保守兜底；忽略 failed/orphaned/未冻结/sourceReplaced/未来 Long，不从自由文本推断完成，不替代直接 Summary 结果或人工纠错。

cache-control 原手动重建及发布边界无需逻辑修改：别名纠正和有效摘要视图使重新注入清除当前栏目的旧任务/旧数字，历史 Story So Far 保留。原快照加载和后台 Summary 不改变冻结字节。KEEP 相似两组各有独有信息，继续精确去重，不做无证据语义合并/整条删除。Summary 统计、Token 预算、注入位置、Strict Cache、Claude 缓存不改。

验证：7 项新回归覆盖新手任务/属性别名、不同人物和第二次任务隔离、孤立增量、Long 结算兜底/人工优先、手动重新注入与当前正文选择、历史字节和原记录不变、KEEP 独有信息保护。npm test 279 项全通过，另运行语法和差异检查。

# 接续说明（2026-10-10，v1.22.9）

用户澄清概览应保留分母，标题准确改为“摘要：已生成 / 应有”，数值使用 generated / expected（例如 229 / 229）。有效统计继续只在保存与诊断显示。仅修正显示和版本缓存 URL，记忆处理逻辑不变。

# 接续说明（2026-10-10，v1.22.8）

按用户截图反馈，仅简化概览：摘要卡片显示当前聊天已生成的实际条数（例如 229 条），不显示有效/应有或分母；移除概览状态区重复的有效性统计说明，存储总数和有效/应有统计保留在原“保存与诊断”。不硬编码 299，不改变记忆选择、校验、状态继承、生成、注入和缓存。版本与模块 URL 更新。

# 接续说明（2026-10-10，v1.22.7）

本轮仅修复状态继承/KEEP/注入重复与摘要统计。threadKey 只规范明确任务名外壳，不按语义相似度合并；projectActiveState 保留最早 ID，按人物与规范任务名回放旧不同 ID 的增量，完成事项防自动复活。stateContext 保留结束状态及确认楼层；Summary 新请求仍使用原 Changes，没有新请求/标签。Checkpoint 当前栏目统一处理键控状态，历史因果保留，认知放原秘密栏目；较早的认知增量不覆盖新模型已有认知叙述。KEEP 仅依据同源、同主题、同观察者的明确后续知情变化或键控状态变化退出当前投影；原 registry 保留，原提交事务应用 lifecycle，迟到结果不恢复已结束 KEEP。长期状态事实更新跳过未变的值。

summaryForEntry/currentSummaryHealth 与 currentSummaries 统一统计/整理选择，实际正文指纹优先；旧指纹完全吻合可用，无指纹仅保留不作整理输入且不自动重生成。empty/orphaned/旧正文/未知来源分开诊断。概览和诊断明确存储记录总数、当前有效/应有数。

index 为注入提供当前正文匹配的摘要视图。Strict Cache 仅在原允许事件组装新投影；旧快照加载及后台 Summary 不变，已发布块原字节不重写。新块/手动重建时纠正键控状态，重复的同一人物同一字段仅在新增块去掉精确重复，状态变化继续出现，Story So Far 保留。Long 边界压缩和 Claude 适配器未变，无新增预算、模块或记忆标签。用户已有错误冻结块要用原“重新注入”刷新投影，无模型请求，不重做历史。

用户提供的私人数据只在本地只读检查，绝不提交剧情、JSON、角色身份或凭据。回归使用合成角色、任务及状态。本轮没有更改在线聊天或触发私人模型生成。

验证：npm test 全部 272 项通过，新增 12 项覆盖任务旧 ID 合并/完成防复活、不同人物及重复任务隔离、首次明确结算、认知 KEEP 与观察者隔离、当前状态跨栏目去重、244 存储与 225/226 有效口径、正文不匹配/空摘要/无指纹不参与整理、Strict Cache 旧字节不变/新块去重、KEEP 并发保护及较新 Long Fact 不被旧增量覆盖。长期投影同样排除待复核状态。

# 接续说明（2026-10-10，v1.22.6）

本轮基于 12b9c97。用户要求一层一份当前 Summary、一段一份当前 CP/Long，保存确认后直接替换旧版本；能证明已替代的旧数据清理，不确定保留；不因加载／旧指纹创建版本；不改注入、Strict Cache 或界面。

根因：messageIdentity 包含生成信息，Swipe 可换 ID；旧 rebindSummaryAtMessageIndex 只移动键并改 KEEP，漏 CP/Long 引用且会把旧正文摘要直接当成新正文；CP/Long 收集 Object.values(summaries) 按 floor，允许同层旧 unverified 记录一起入模型；aggregate add 只按 ID 替换，范围重复可保留。

utils 为 assistant entry 带实际 swipe_info/swipes 身份及 sourceMessageKey，不改原 messageIdentity 算法，也不修改聊天消息。显式编辑/Swipe 只登记运行期同槽关系，正文未匹配不再提前重绑定旧摘要。MemoryStore.currentSummaries 逐条当前 assistant 选一个匹配摘要，旧指纹缺失保守接受唯一 legacy floor-only 数据，不制造新 ID；未知/未匹配副本不送入生成上下文。已知 sourceContentFingerprint 不匹配则等待新摘要；不恢复旧 stale 技术提示。Summary 替换修正 KEEP/stateOverrides/sourceVersions/summaryIds，旧 ID 留无正文 replacedBy tombstone 防旧窗口复活。引用的正文已明确替换时 sourceReplaced 只供后续生成/一键补全使用，不改冻结显示及已发布注入字节；普通加载不设置该标记。CP/Long 按精确范围替换全部旧副本，重绑 checkpointIds/previousCheckpointId/checkpointVersions；无证明的范围冲突保留，显式重生成可以整段替换。

MemoryPersistenceCoordinator.commitReplacement 串行构造候选，先等原记忆确认；同步构造时暂缓 persist/onChange，旧有效视图保持到服务器读回。失败从 replacementFallback 保留原有效记录，新候选只在临时 pending journal 重试，成功清理；不新增永久备份。保存中再次编辑则按共同原快照合并不相交修改，同条本机更新不被较早模型草稿覆盖，生成任务核实自身结果确实生效才报成功。服务器仍用既有三方比较/CAS/读回，不按客户端时间戳决定胜负。生成前捕获目标记录及输入版本，模型完成及提交前再次检查，包括首次服务器核验读到更新目标的情况。空输出不替换原记忆。生成后 publish/onChange 的原因沿用原注入规则，重试成功也通知。

index 显式编辑/Swipe 在原 autoSummarize 条件下调用当前条目总结；相同正文无额外请求。refreshChatState 读服务器并 sync 后，若存在可确认旧记录，以同一事务清理；旧 Summary 凭实际 Swipe 身份/明确事件/同来源标识清理，聚合凭相同内容或当前来源证据去重；不靠楼层或时间戳猜测。不要清空未知孤立记录。注入/缓存等其余模块仅版本 URL 更新。

验证：npm run check、npm test 全 260 项通过；新 current-memory-replacement.test.js 15 项包含第207层及CP-042输入/引用、保留有效视图直到读回、原生/权威失败回退、范围替换与引用、保守清理、缺指纹/刷新、首次核验读到新版本、空模型输出、保存中用户再次编辑、另一设备新记录及旧替换 ID 防复活。旧冻结测试改为验证格式差异不会重做，去掉“实际改了正文却必须给CP用旧摘要”的过时断言；continuity 测试现在提供已加载的合成 chat，不再用空聊天生成范围。Chrome 合成界面绑定实际 commitReplacement，验证209层生成4Long/读回/查看全文及手机布局/四边缩放。无真实模型或私人聊天。版本 1.22.6，Store v6 未升级。

限制：原生 ST 无原子 CAS；没有服务端推送，所有旧窗口都应更新并重载。清理仅作用于实际载入的聊天；无法证明归属的旧数据保留。已有已发布剧情文本不会被本地清理自动改写，明确来源被替换的阶段／长期记忆需按现有补全或重新生成操作重新保存。

以下历史说明服从当前版本及最新用户要求。

# 接续说明（2026-10-10，v1.22.5）

本轮基于 6e602f5。用户最终取消下拉框方案，保留分类按钮；分类按钮入框自动换行、随内容滚动。新增独立 Long Memory 页，显示已生成 / 应有、缺失完整楼层分组、明确生成入口及可展开原始正文；原长期事实页保留投影事实及编辑能力。原入口藏于长期事实页底部，摘要/CP 的局部处理完成并不代表 Long 已生成；各自完成提示标明范围，一键/Long 补全结束重查计划，仍有缺项不能报完成。概览 CP/Long 使用 isUsableMemory 计数，不再误排除只有结构化 factUpdates 的记录。应有 Long 组长对齐原有 CP 完整分组规则。

fillMissingMemories 增加 onlyLong 范围：仅补缺失 Long 分组及这些分组所需的摘要/CP，不改模型、提示词、注入、冻结、缓存或保存逻辑。仍串行生成、每条保存确认、失败停止；原一键全部补全继续可用。

主窗口新增外框与四边 PointerEvent 缩放手柄，支持鼠标/触摸，另一边保持位置，最小尺寸受实际可见区域限制。viewport resize/scroll 时重置偏移并限制已选尺寸；会话内关闭重开保留尺寸，不新增持久化设置。主窗口 × 仍 sticky；手机标题不能拖走窗口，桌面标题拖动保留。手柄层级在 panel 之上以避免被遮挡。

验证：17 项 fill-all-memory / ui-context 定向检查，UI/summarizer 语法与 diff 检查；临时独立 Chrome 合成界面验证 209 层、41CP、0Long → 4Long 并模拟服务器读回、展开全文，手机八个分类按钮换行并随内容滚动，桌面和触摸四边缩放/边界/×，以及 v1.22.4 长确认弹窗与可见区域偏移回归。没有真实模型或私人聊天请求；未跑全套。浏览器关闭。版本和模块 URL 统一 1.22.5。以下历史说明以本段及当前用户指令为准。

# 接续说明（2026-10-09，v1.22.4）

最新用户要求：手机确认弹窗不得弹到可见屏幕外，关闭 × 固定右上角，无需滚动寻找。基于 69a0a50，仅 UI 改动。bindDialogViewport 为主窗口及确认弹窗设置 visualViewport 实际边界，监听 resize/scroll 并批处理，关闭/卸载清理监听。主标题纳入 sticky pinned 区，更新桌面/手机网格行；手机禁用标题拖动，桌面鼠标拖动保留。确认弹窗为固定标题/操作区加内部内容滚动，新增 × 取消，Escape 不再冒泡关闭后方主窗口；换弹窗/卸载时结束旧对话并清理监听。CSS 对长单词、窄宽和安全区做约束。版本及模块 URL 统一 1.22.4，不改保存、生成、提示词、注入或缓存行为。

本次验证：10 项 ui-context 检查、UI/viewport JS 语法与 diff 检查；临时独立 Chrome 合成页面通过 390×700 手机长消息、滚动后两种 × 的位置、可见区域 370×300 + 偏移（键盘/缩放）、关闭即取消及主窗口关闭。仅路由公开 JS/CSS/合成 fixture，未监听本地 HTTP 端口、未访问私有聊天或模型。浏览器已关闭。不要跑整套测试。

最新用户要求：顶部有明确“上传记忆到服务器”和“从服务器恢复记忆”，只做必要检查，避免整套测试、浏览器预览和扩展范围。基于 f19e492。上传沿用安全保存与读回，恢复直接读服务器，不先 flush 本机 pending；有差异/未保存修改时一次确认，以服务器内容替换本机，不写服务器。restoreServerSnapshot 校验准备时的聊天、epoch、digest、队列 sequence，废弃迟到读取并清理待保存队列。服务器无记忆则明确报错。JSON 下载导入保留，不改变冻结、注入和缓存规则。按钮相关检查和保存恢复定向测试即可。

最新追加：用户明确要求“一键补全所有记忆”及实际变动才自动保存。fillMissingMemories 串行 Summary → CP → Long，计划覆盖启动时完整楼层分组，保留所有可用冻结记录，补先前区间缺口，原模型/注入规则不变。每条成功后 flush 确认；错误/未确认/聊天变化/取消停止。UI 复用 missingCheckpointController/runId 以保留停止、切聊天和卸载保护。先 reread，避免为服务器已有记录重复生成。

重复自动保存：enqueue 相同待保存或已确认基线内容不重新排队；主动上传/import/migration 仍可强制核验。sourceValidity 诊断变化不单独 persist。用户最终明确取消跨设备日常核对，以刷新/重新进入时服务器最后成功保存的版本为准：focus 完全移除，visibility 只保留本地 pending journal，无网络读取；online 仅重试 pending。refreshChatState 改为 loadLatest（暂停队列、读服务器、直接替换并清理 pending/conflict，不自动合并）；读取失败保留本机/队列，不立即重试。新装权威库无记录时先读原生服务器旧记忆再迁移，不能空初始化。保存自身的三方比较/并发保护/CAS及读回仍保留。恢复确认使用 pauseSaves，取消后恢复队列，确认则清理；已开始写入等完成再读取。

当前定向检查为 44 项（fill-all-memory、memory-sync-import、persistence）和改动模块语法检查；不跑全套/浏览器/私人模型。

仓库：https://github.com/soso454u/SillyTavern-Cache-Memory 。先核对 README、git status/log 与远端。不用子代理、私人聊天或付费 API 测试；提交推送以实际结果为准。

本轮基于 368e39f/v1.22.1，Store 仍为 v6。用户明确追加并覆盖旧要求：生成后冻结，彻底取消来源/版本自动失效及相关提示与 CP/Long 阻挡；恢复副本也删除，只保存自己当前版本，不能再累积备份或自动下载。不要因旧文档要求恢复备份、来源失效或自动模型更新。

normalizeStore 解除旧 stale/sourceValidity changed/invalidSource 标记，保持正文、人工编辑属性、失败状态、明确 orphaned 和冻结注入快照。syncMessages 继续身份关联/楼层定位，但来源不匹配只作内部未验证信息，不会影响使用；validateDependencies 仅兼容清理旧标记，不再连锁失效。isUsableMemory、summaryIsCurrent 和状态投影均不排除旧来源标记。已有内容可直接生成 CP/Long；只有显式用户重生成会替换已有记录，单条 CP 更新不再被“已有效”自动拒绝。人工事实修订保留 factCorrection 供用户明确调用维护，不自动重生成或失效。请求正在执行时的输入变化仍拒绝提交迟到输出。

删除 archive 和永久 recovery 数据累积，载入与导入丢弃旧 recovery，旧本地迁移备份删除；常规下载只含当前记忆。服务器读回发现旧 recovery 时，保存队列即使内容摘要一致也实际写回清理。旧权威插件可通过 CAS 比较基线携带原 recovery 实现删除；新版服务端合并也直接移除 recovery。无备份导出入口，诊断折叠区改称保存与诊断。确认导入与清空说明不再承诺可恢复。用户主动替换/清空后没有历史档案撤销。

保留此前保存修复：安全三方比较，独立变更合并，同 ID 双边修改/删除与编辑冲突停止；显式选择/JSON 恢复经确认再替换。导入 restore 意图必须等于最新服务器基线才可写入，CAS 有限重试与实际读回，旧 v1–v4 作用域兼容且核对来源身份。各窗口临时 pending journal 保留未保存内容和未解决冲突，确认完成后清理，不保存到记忆 JSON。旧 journal 的 recovery 在恢复时清理。

保留完整注入与现有发布边界、Strict Cache、Claude 缓存、整理/生成流程、Summary/Checkpoint/Long/KEEP/角色状态、自定义提示词；模块 URL 与版本统一 1.22.3。

验证：227 项本地测试及语法检查。新增 frozen-memory.test.js 复现截图的205条可用+2失败、第14层不阻挡11–15阶段生成、旧CP支持Long、手动重生成、请求中变化阻断、原生/权威清理服务器备份；原服务端插件测试覆盖真实路由与磁盘。合成浏览器界面确认205条全部可用、来源更新提示与恢复入口均不存在；临时仅公开资源预览服务已停止。未连接用户真实服务器。

限制：原生 ST 无原子 CAS；可选权威锁限单 Node 进程；持续打开窗口没有服务器推送通知。两端均更新并重载。不要宣称已删除用户设备下载文件或修好了模型 Unauthorized。
