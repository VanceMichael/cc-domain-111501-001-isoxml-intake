# 农机任务交付的设备元素与作业量采集接入约定

## 来源获取

获授权供应方网关 `/taskdata` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

源网关提供文件目录和任务归属，raw为ISOXML子集；不要求解码二进制TLG。TSK A为任务身份，TIM内DLV的A/B/C为DDI、原始值、设备元素引用。设备DET通过DOR指向本DVC的DPD，再由F指向DVP。DVP的B/C/D/E为offset/scale/decimals/unit，显示值为(raw+offset)*scale；资料profile约定同文件DVC内对象号有效。目录的task属性声明device文件属于task-1。记录id采用task:DET设计名称:DPD设计名称，原始200和300分别为20L和3L，不能按相同DDI混并。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：设备文件rev2把右段scale改成0.02，解释值变为6L，旧版3L及原始300仍可追溯。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置和未决原因。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 本profile的实现语义

managed模式（`collect({mode:'managed'})`，见`src/managed.mjs`）按以下规则落地上述约定：

- 解释链路为纯函数（`src/isoxml.mjs`）：`parseTaskFile`提取TSK/TIM/DLV并保留每个DLV的文件内位置；`parseDeviceFile`建立DVC内DET→DOR→DPD→DVP对象号映射；`resolveReadings`把读数绑定到唯一设备元素，再按同DDI匹配DPD与DVP，显示值为`(raw+offset)*scale`并按decimals取整。每一步写入`basis`追溯链，原始整数始终保留在`readings[].rawValue`。
- 记录的存储键是结构身份`task|DET对象号|DDI`，业务id`task:DET设计名称:DPD设计名称`仅在设计名称被真实解析后存在；未解释记录使用`pending:`前缀id且`value`为null，任何路径都不会写入0或默认单位。
- 未解释分两类：资料缺口为`pending`（设备元素找不到、DOR缺失、DVP未解析、文档404/503/格式错误），资料互相矛盾为`conflict`（元素不支持该DDI、候选DPD不唯一、同一对象号出现在多个DVC）。两者都附具体资料位置并进入notes。
- 每次采集从已留存原始字节重新解释。同一结构键的解释发生变化时，`pending→resolved`记为`supplement`（迟到补件），其余变化记为`revision`（矛盾/新版本），历史解释、旧版字节摘要与原始值都保留在`revisions`和文档`versions`中，可核对但不覆盖。
- 条件请求带`If-None-Match`，304不重取正文；ETag与实算摘要不一致时留note。目录不可达、文件503/404均不删除既有记录，只更新可恢复状态；当前目录不再包含的旧记录加`flag`而不是删除。
- 两层完成度：`documentComplete`要求目录中每份文件都已取得且无失败状态；`interpretationComplete`要求无pending、无conflict、无解析问题。`complete`为两者交集，HTTP 200或预览成功不参与判定。
- 进程终止恢复依赖持久化的`evidence/raw`、文档索引`documents`、游标`managed:catalog`与`managed:latest`；重新打开仓库后重跑采集即可补齐未提交的解释，不依赖固定样本。`crashAfterRetain`是仅供验收的终止注入缝。

## 验证矩阵

1. 按样本跨文件完成 任务与机具元素关联 与 日志列定义绑定，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. 原始值与显示量分离 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 迟到设备描述定向补采 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`仅覆盖关键正例及重启重投，改动时需按以上矩阵增加适合方案的异常和来源变化测试。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
