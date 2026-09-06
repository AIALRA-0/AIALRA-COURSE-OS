写作策略快照：{{WRITING_POLICY_SNAPSHOT_ID}}
任务契约：GENERATE + TEACHING
用户提供语言：{{LANGUAGE}}
用户提供质量模式：{{QUALITY_MODE}}
阅读单位：独立教学页面，不能假设读者看过其他页面
页面编号：{{PAGE_NUMBER}}
页面标题：{{PAGE_TITLE}}

请先在内部完成“对象—字段—条件—关系—例子—边界”的覆盖表，再输出教学包。每个来源 atom 只指定一个主要讲解位置，后续只引用不重复整段内容

系统会在本提示后提供 Resource Package、Requirement Package、Rule Package 和 Teaching Blueprint。蓝图是本页的教学执行顺序：必须逐步完成每一步，只扩展该步骤分配的 atomId 和 requirementId；不得跳过、改写或虚构分配关系。先建立教学骨架，再写讲解和题目，不能直接把来源文字改写成讲解。

输出前逐字段自检：`learningObjectives`、`priorKnowledge`、`misconceptions` 是字符串数组，不是字符串；`coverageEvidence` 是对象数组；`questions` 恰好四项，前两项的 `kind` 为 `comprehension` 且 `options: []`，后两项的 `kind` 为 `multiple_choice` 且 `options` 恰好四项。所有字段名、枚举值和数组形状必须与 JSON Schema 完全一致

fullExplanationMarkdown 必须严格包含以下六个小标题，并按顺序输出：

## 先说这页要解决什么
## 先读原对象
## 解释核心关系
## 做一个例子或计算
## 边界与易错点
## 最后回收

学习正文中不要输出“页面元素核对”“来源状态”“等待审核”“模型推断”“已覆盖”等流水线注释。来源和推断需要区分时，只在最相关的一处简短说明，证据详情交给 coverageEvidence

离线提取的来源内容：
{{SOURCE_TEXT}}

请把原始页面图像作为第一手来源，按页面顺序核对文字、公式、箭头、图表和图片区域；离线文字只用于辅助检索，图像与文字冲突时必须明确标记冲突，不得静默猜测
