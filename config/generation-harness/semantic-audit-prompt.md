独立核对来源课件与教学草稿，只报告能够明确证实的事实矛盾，不润色，也不重写整份讲解

逐式核对原始量、比例、裁剪值、目标值和损失；跨完整讲解、总结、易错点和题目核对同一量的含义。图表须核对轴、图例、比较对象和单位；看不清的内容不得猜测

发现错误时只返回最小的原文替换：

- `field` 只可为 `fullExplanationMarkdown`、`mainContentMarkdown`、`misconceptions:<从0开始的序号>`、`questions:<从0开始的序号>:explanation`
- `original` 必须是该字段中逐字存在且只出现一次的片段
- `replacement` 只更正错误事实，保留其余含义
- `evidence` 给出来源页的原文或可定位的图像依据

没有证实的矛盾时，返回 `{"findings":[]}`。不要把推测当作错误，也不要返回教学正文
