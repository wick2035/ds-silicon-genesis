# 聊天记忆检索

记忆使用百炼 `qwen3.7-text-embedding-flash` 获取语义候选，与 PostgreSQL 词项候选合并，再由本地 `Qwen/Qwen3-Reranker-0.6B` 评分。检索包含 SAG2 的候选扩展思想，但不是 SAG2 官方实现或英文基准的复现。近似向量桶最多选出 1000 条候选，精排最多处理 24 条；相关性阈值是启发式的，可能漏召回或误召回。星图中的词项连线只是可追溯的关联，不证明人物关系或因果。

## 配置与数据

- 复用 `data/model-config.json` 中首个阿里云百炼业务空间地址和密钥。聊天原文及查询文本会发送至百炼生成向量，可能产生调用费用；精排始终在本机进行。模型或接口不可用时使用关键词结果，状态显示在星图中。
- 本地精排模型固定为 Hugging Face 版本 [`e61197ed45024b0ed8a2d74b80b4d909f1255473`](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B/tree/e61197ed45024b0ed8a2d74b80b4d909f1255473)，文件放在 `data/models/qwen3-reranker-0.6b`，启动时校验权重 SHA-256。使用具备 PyTorch、Transformers 和 safetensors 的 Python，可通过 `SILICON_RERANK_PYTHON` 指定解释器。权重不加入 Git。
- `life_state` 是权威数据；文档、词项、向量和关系都是可再生成的派生数据。有效性、来源和内容指纹会在召回时再次核验。桌面、私聊和群聊共享同一个角色的经历：群聊可读取近期私聊作为内部记忆，并按本轮选定话题检索较早的经历；私聊也能看到近期听到但未回复的群消息及带发送状态的群回复。跨渠道资料保留时间、可信发言者、渠道和失效依赖，不作为当前发言或待执行指令；群回复只自然回应已经公开的话题，不主动披露私人细节或保密内容，群回复只有确认送达后才作为已发生的对话。
- 先停止本应用或确保没有实例持有写入租约，然后运行 `node tools/migrate-memory-index.mjs`。脚本先备份原始数据，再执行可重复运行的迁移。每次启动会从权威状态续建缺失索引；恢复已有备份到空数据库后，运行迁移并启动应用即可重建派生数据。重建向量需要再次调用百炼。

## 验证

`npm run build` 后，`node --test tools/memory-associations.test.mjs tools/memory-embedding.test.mjs tools/qq-chat-identity.test.mjs` 验证基本行为。`node tools/memory-benchmark.mjs` 使用合成中文样例调用真实百炼和本地重排（会产生少量费用），可比较词项和混合检索；不能把小样本结果等同于真实对话效果。
