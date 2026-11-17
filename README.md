# 农机任务交付的设备元素与作业量采集

Node.js 22.23.4 ESM 资料接入服务。现有服务提供单文件预览、原始字节留存和重复导入；自动结构化接入由managed模式调用。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证旧版预览、来源HTTP缓存与故障响应、存储重开、ISOXML领域解析与仓库版本索引。demo当场创建空目录并启动真实回环HTTP服务、先完整managed接入再把来源切到round=2修订，打印作业记录、原始值与解释依据、补件/修订审计链和留存版本；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。legacy返回`{imported,complete:false,mode:'legacy'}`；managed返回两层完成度（`documentComplete`、`interpretationComplete`、`complete`）及`pending`、`conflicts`、`supplements`、`revisions`、`pendingFetches`等诊断计数，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断。`Repository`中的records、evidence、cursors、notes是现有持久化接口（旧记录和原始字节继续可读），managed模式另用`documents`（文档索引与全部版本）和`work`（规范化作业记录，键为`task|DET对象号|DDI`，业务id为`task:DET设计名称:DPD设计名称`）；未解释记录为`pending:`前缀id且value为null，绝不填零。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开。managed模式已实现跨文件解释：验收覆盖协议验证矩阵全部五项——跨文件任务/元素/单位绑定、重复投递与重开不膨胀、缺件与原始值保留（未识别数据永不填零）、迟到补件与round=2矛盾版本的留痕区分、边界终止后重启恢复，以及DDI冲突隔离、目录故障保留和投递顺序无关性。新增断言不得删除、不得固定输出样本答案或让原始证据与规范化结果错位。

## 离线容器

```sh
docker build --pull=false -t isoxml-intake:local .
docker run --rm --network none isoxml-intake:local npm test
docker run --rm --network none isoxml-intake:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
