# 本地开发手册

## 1 安全默认路径

合成演示不读取私有课件、不调用模型、不访问外部 URL，也不需要真实密钥

## 2 启动步骤

- 第一步，安装依赖：

  ```powershell
  corepack enable # 启用仓库声明的 pnpm
  pnpm install --frozen-lockfile # 按锁文件安装全部工作区依赖
  ```

- 第二步，建立合成课程：

  ```powershell
  pnpm seed:synthetic # 写入可重复执行的合成发布
  ```

- 第三步，启动 API：

  ```powershell
  pnpm --filter @course-os/api start # 默认监听 127.0.0.1:4100
  ```

- 第四步，启动网页：

  ```powershell
  pnpm --filter @course-os/web dev # 使用终端打印的本地地址
  ```

- 第五步，核对结果：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:4100/healthz # 只验证进程存活
  Invoke-RestMethod http://127.0.0.1:4100/readyz # 单独验证已确认的阅读副本就绪
  pnpm verify:tree --synthetic # 验证合成材料当前入口
  pnpm verify:course --synthetic # 验证合成页面与版本结构，不启动教学质量评价
  ```

## 3 私有 EE680 路径

`EE680_SOURCE_DIR` 必须指向仓库外目录；种子脚本只把字节写入被 Git 忽略的 `var/cas`

不要复制、移动或提交原始课程材料

## 4 停止与清理

停止终端进程不会删除课程发布

五次独立 API 重启及选题、作答持久化回归使用 `pnpm exec tsx scripts/verify-reading-stability.ts`；它创建临时合成数据，不读取私有课件或调用教学模型。浏览器学习操作和公网登录验收仍须分别执行，不能用该脚本替代

`var` 包含本地课程、问答和掌握记录；删除前必须先确认不需要恢复，当前手册不提供自动删除命令
