# GrsAI Skill

通过 GrsAI 生成文本、图片和视频，按任务约束与原始积分预算选择型号。支持 HTTPS 参考素材、图片问答、异步查询和本地结果保存。

需要 Node.js 22+、Python 3（macOS/Linux）；视频检查需要 `ffprobe`。

```bash
npm ci
python3 scripts/run.py init
```

首次调用会生成 `.env`，只需在本地填写 `GRSAI_API_KEY`。环境文件和任务记录不会提交到 Git；仓库不包含凭证或预配置账号。

将本仓库目录放入 Agent 的 skills 目录，通过 `$grsai` 使用。调用方法和恢复规则见 [SKILL.md](SKILL.md)，型号参数与价格见 [模型选型](references/models.md)。
