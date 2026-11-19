# kubernetes-pdb-eviction-simulator
模拟 Kubernetes PDB、节点排空与多故障域驱逐约束

离线 PodDisruptionBudget 驱逐模拟器（Node.js 24.16.0），**不连接 Kubernetes 集群**。
按「一次一个 Pod」的语义模拟节点排空：每驱逐一个 Pod 立即更新健康计数，
再判断下一个 Pod 是否被 PDB 阻塞，而不是把节点上的 Pod 一次性全部删除。

## 使用

```bash
node src/cli.js examples/blocked.json
node --test   # 运行测试
```

## 输入格式

```json
{
  "nodes": [{ "name": "node-1", "zone": "zone-a" }],
  "pods": [{
    "name": "web-1",
    "node": "node-1",
    "labels": { "app": "web" },
    "controller": "deployment/web",
    "healthy": true,
    "evicted": false
  }],
  "pdbs": [{ "name": "web-pdb", "selector": { "app": "web" }, "minAvailable": 2 }],
  "failedZones": ["zone-b"],
  "drainOrder": ["node-1", "node-2"]
}
```

- `minAvailable` / `maxUnavailable`：整数或百分比字符串（如 `"30%"`），百分比向上取整，与 Kubernetes 一致。
- `evicted: true`：模拟开始前已被驱逐的 Pod，不计入 PDB 统计。
- `failedZones`：区域故障，其中的 Pod 一律视为不可用。
- `drainOrder`：计划排空的节点顺序；未列出的节点不会被排空。

## 模拟语义

- 按 `drainOrder` 逐节点、逐 Pod 尝试驱逐，每次驱逐后重新计算 `disruptionsAllowed`。
- 多个 PDB 命中同一 Pod 时，**全部**满足 `disruptionsAllowed > 0` 才放行（取最严格者）。
- 不健康或位于故障区域的 Pod 不计入健康数，会提前耗尽驱逐额度。
- 每个 PDB 的期望副本数在模拟开始时确定（假设控制器会补齐被驱逐的 Pod），
  百分比 PDB 的分母不随驱逐过程缩减。
- 无法继续驱逐时，输出具体阻塞的 PDB、被阻塞的 Pod 及解除条件
  （需要恢复健康的 Pod 数，或需要放宽的 PDB 配置）。

## 重要限制

**模拟结果不等同于 API Server 的实时判定。** 真实的驱逐由 API Server 在收到
Eviction 请求时基于集群当时的状态裁决：控制器可能随时创建替代 Pod、其他
Pod 可能并发被驱逐、PDB 状态存在缓存延迟与竞态。本工具只做离线推演，用于
在排空前发现明显的 PDB 冲突，不能替代 `kubectl drain --dry-run` 或实际驱逐
时的 API Server 判定。
