# 调用契约

2026-10-14核对供应商公开接口。全球节点为 `https://grsaiapi.com`，国内节点为 `https://grsai.dakka.com.cn`。调用者自行配置凭证；认证只发送到这两个官方origin。

| 任务 | 请求 | 结果 |
|---|---|---|
| 图片、视频 | `POST /v1/api/generate`：model、prompt、型号参数、replyType:async | 保存供应商返回的id |
| 原任务查询 | `GET /v1/api/result?id=…` | 状态和结果URL；不生成新任务 |
| 文本、看图 | `POST /v1/chat/completions`：model、messages、stream:true | 流式正文和可获得的usage |

本包仅接受HTTPS参考URL。`images`、`audios`、`mask` 均由调用者提供可被供应商读取的链接；不上传本地文件。图片问答使用messages中的 `image_url` 内容项。统一聊天文档描述图片输入格式，不保证每个型号的理解效果。

Nano图片参数用 `imageSize`；GPT用比例或原生像素 `aspectRatio`。GPT兼容型号可传 `quality`、`background:transparent` 和 `mask`。遮罩编辑要求至少一张原图；路由内部将遮罩标识设为 `maskAssetId:mask`，调用时转换成mask URL。型号尺寸、比例、质量、透明和参考数量见 [模型说明](models.md)。

文本 `maxTokens` 在本包范围为1–8192，映射为 `max_tokens`；这是本包保护限制。公开聊天文档未列出所有型号的最大输出长度及 `stream_options.include_usage` 参数，是否接受需当前渠道验证。本包不提供工具调用、检索、结构化响应保证或多轮会话存储。

## 费用与结果

全部积分字段使用原始积分；`selection.maxCredits` 只接受非负整数。图片按次、视频按分辨率和秒数估算。文本以UTF-8字节数作为输入Token近似值，每张参考图增加32000的输入估算量，再加最大输出Token预算；这是本包启发式估算，不能保证实际费用不超过预算。`usageCredits` 根据有效usage和公开价格估算，有效缓存Token才采用缓存价；缺失usage返回null。供应商实际扣费、退款与余额须另行核对。

供应商生成状态包括running、succeeded、failed、violation。查询原id不会新建任务；收到结果后仍需检查输出。没有可靠提交结果时保留本地记录，不自动重新提交。CLI的request-id用于本地防重复，供应商原生幂等没有公开保证；内容或模型改变时使用新的本地编号。

结果URL及时下载，时效与续期以供应商当前公告为准。生成成功、保存成功和内容合格是分别检查的步骤。

来源：[Nano](https://qmy27nhsd9.apifox.cn/452392911e0)、[GPT图片](https://qmy27nhsd9.apifox.cn/452409160e0)、[Minimax](https://qmy27nhsd9.apifox.cn/514679297e0)、[Agnes](https://qmy27nhsd9.apifox.cn/523334530e0)、[聊天](https://qmy27nhsd9.apifox.cn/452418916e0)、[异步查询](https://qmy27nhsd9.apifox.cn/452409577e0)、[供应商公告](https://grsai.com/zh/dashboard/announcements)。
