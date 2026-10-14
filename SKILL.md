---
name: grsai
description: 使用 GrsAI 生成文本、图片和视频，支持图片问答、HTTPS 参考素材、模型选型、原始积分估算和任务恢复。用户指定 GrsAI 或其模型，或需要通过 GrsAI 生成内容时使用；首次调用先生成只含 API Key 的环境文件。
---

# GrsAI

根据任务选择符合要求的型号，提交一次生成请求，取回并检查结果。用户指定型号时保留选择。

## 初始化

从本 Skill 目录执行 `python3 scripts/run.py init`。首次调用也会自动在 Skill 根目录生成权限为 600 的 `.env`，内容只有 `GRSAI_API_KEY=`。没有 Key 时返回 `configuration_required` 与文件路径，提示用户在本地填写；填好后继续原任务。不要让用户把 Key 发到聊天中，不读取其他项目的配置。

支持显式 `--env-file /绝对路径/.env` 或环境变量 `GRSAI_API_KEY`。环境文件不会被覆盖，也不会把已有环境变量写回文件。运行需要 Node.js 22+、Python 3 的 POSIX 文件锁；`npm ci` 安装依赖，视频检查需要 `ffprobe`。

## 选型与调用

先读 [模型选型](references/models.md)。根据内容类型、用途、参考素材、尺寸/比例、透明/遮罩、视频时长和预算填写 `selection`，运行推荐。仅按接口能力和明确约束筛选；没有可信对照时，不按型号名称或价格认定质量、速度领先。

请求写到当前任务的 `work/` 下，权限 600：

```json
{
  "type": "image",
  "model": "auto",
  "prompt": "一只蓝色陶瓷杯，白色背景，产品摄影",
  "images": [],
  "params": {"aspectRatio": "16:9"},
  "selection": {"intent": "product", "resolution": "2K", "maxCredits": 2000}
}
```

`type` 为 `chat`、`image` 或 `video`；参考素材仅接受公开 HTTPS 地址。`model` 为 `auto` 或准确的供应商 ID。`selection.maxCredits` 使用供应商原始积分，估算不等于实际账单或硬扣费上限。参数范围见 [调用契约](references/api.md)。

```bash
python3 scripts/run.py recommend --request /绝对路径/work/request.json
python3 scripts/run.py create --request /绝对路径/work/request.json --output-dir /绝对路径/outputs --dry-run
python3 scripts/run.py create --request /绝对路径/work/request.json --output-dir /绝对路径/outputs --request-id UUID
python3 scripts/run.py wait --jobID UUID --timeout 55
python3 scripts/run.py status --jobID UUID
```

提交前保存一个 UUID。`wait/status --jobID` 使用本地返回的 `jobID`，等于 `--request-id`；`remoteId` 由脚本查询供应商。等待结束后需要保存时运行 `status`。任务记录在 `.local/jobs`，生成结果保存到指定目录。

断线后沿用原编号。`running` 继续查询；`storage_pending/storage_failed` 补做原结果保存；无远端编号的 `uncertain` 或聊天断流不自动重发。失败扣费和退款需要供应商记录确认。多次调用按剩余总预算执行，更换型号或重做会产生新的调用。

## 验收与交付

图片检查主体、参考保持度、文字、实际尺寸和 alpha；视频实际播放并检查时长、画幅、动作和声音；文本检查内容与用户要求。参数支持不保证成品满足全部细节，大量文字宜用确定性排版。

交付本地绝对文件路径，图片用 Markdown 图片嵌入，视频使用可用的预览。只反馈结果和必要限制，不输出 Key、签名地址或私有任务记录。资料日期为 2026-10-14；维护、价格或能力变化时重新核对公开来源。
