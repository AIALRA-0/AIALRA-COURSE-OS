# P0 需求追踪矩阵

## 1 使用方法

状态只有 `planned`、`implemented`、`verified` 和 `blocked`

`implemented` 表示实现已存在，`verified` 表示对应测试和验收证据已经通过，两者不能混用

## 2 追踪矩阵

| ID | 需求 | 实现位置 | 测试 ID | 当前状态 |
|---|---|---|---|---|
| P0-01 | 课程、模块、讲义和材料管理 | `packages/domain`、`apps/api` | COS-C01 | implemented |
| P0-02 | PPTX、PDF、syllabus 导入 | `packages/storage`、`apps/api` | COS-I01 | planned |
| P0-03 | 不可变来源版本 | `packages/domain`、`packages/readweave-adapter` | COS-V01 | verified |
| P0-04 | 页面截图和来源锚点 | `packages/contracts`、`packages/teaching` | COS-A01 | implemented |
| P0-05 | 学习目标和前置知识 | `packages/domain` | COS-L01 | implemented |
| P0-06 | 教授级逐页讲解 | `packages/teaching`、`packages/quality` | COS-T01 | implemented |
| P0-07 | 伪代码逐行解释 | `packages/quality`、`apps/web` | EE680-G02 | verified |
| P0-08 | 代码解释 | `packages/quality`、`apps/web` | EE680-G06 | planned |
| P0-09 | 数学解释 | `packages/quality`、`apps/web` | EE680-G01 | implemented |
| P0-10 | 图表和图片解释 | `packages/quality`、`apps/web` | EE680-G03、EE680-G04 | implemented |
| P0-11 | 逐页课堂问答 | `apps/api`、`apps/web` | COS-Q01 | verified |
| P0-12 | 测验、错因和复习队列 | `packages/domain`、`apps/api`、`apps/web` | COS-M01 | implemented |
| P0-13 | ReadWeave 双向闭环 | `packages/readweave-adapter` | EE680-G08 | implemented |
| P0-14 | 版本、证据、质量、成本和发布 | `packages/domain`、`apps/api` | EE680-G20 | verified |
| P0-15 | 左图右文播放器 | `apps/web` | EE680-G10、EE680-G11、EE680-G19 | verified |
| P0-16 | 可靠数学渲染 | `packages/quality`、`apps/web` | EE680-G01 | verified |
| P0-17 | 实时状态和恢复 | `apps/api`、`apps/worker` | EE680-G07、EE680-G12、EE680-G13 | implemented |
| P0-18 | 本地开发与单 VPS 部署 | `compose.yaml`、`infra` | COS-D01 | implemented |
| P0-19 | 隐私与安全 | `apps/api`、`infra`、`docs/runbooks` | EE680-G16、EE680-G17 | planned |
| P0-20 | 磁盘与预算控制 | `packages/storage`、`packages/domain` | EE680-G14、EE680-G18 | implemented |
