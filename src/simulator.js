import { desiredHealthy, podMatchesPdb } from './pdb.js';

// 计算某个 PDB 当前的健康/期望状态快照。
// expectedPods 固定为模拟开始时未驱逐的匹配 Pod 数（即控制器期望副本数），
// 假设控制器会补齐被驱逐的 Pod，百分比不会随驱逐过程缩减分母。
function pdbSnapshot(pdb, pods, expectedPods) {
  const currentHealthy = pods.filter(
    (pod) => !pod.evicted && pod.healthy && podMatchesPdb(pod, pdb),
  ).length;
  const required = desiredHealthy(pdb, expectedPods);
  return {
    name: pdb.name,
    expectedPods,
    currentHealthy,
    desiredHealthy: required,
    disruptionsAllowed: Math.max(0, currentHealthy - required),
  };
}

function describeUnblock(snapshot) {
  const gap = snapshot.desiredHealthy - snapshot.currentHealthy;
  if (gap <= 0) {
    return `等待 PDB ${snapshot.name} 出现至少 1 个可驱逐额度（当前健康 ${snapshot.currentHealthy}，要求 ≥ ${snapshot.desiredHealthy}）`;
  }
  return (
    `等待至少 ${gap} 个匹配 Pod 恢复健康（当前健康 ${snapshot.currentHealthy}，` +
    `要求 ≥ ${snapshot.desiredHealthy}），或放宽 PDB ${snapshot.name} 的 minAvailable/maxUnavailable`
  );
}

/**
 * 按「一次一个 Pod」的语义模拟节点排空。
 *
 * scenario = {
 *   nodes: [{ name, zone }],
 *   pods: [{ name, node, labels: { app, ... }, controller, healthy, evicted? }],
 *   pdbs: [{ name, selector: { app: 'x' }, minAvailable | maxUnavailable }],
 *   failedZones: ['zone-b'],        // 区域故障：其中的 Pod 一律视为不可用
 *   drainOrder: ['node-1', ...],    // 计划排空的节点顺序
 * }
 *
 * 语义说明（对齐 K8s 驱逐子资源）：
 * - 已 evicted 的 Pod 视为已删除，不计入 PDB 的 expected/healthy；
 * - 位于 failedZones 的 Pod 视为不可用（healthy = false）；
 * - 驱逐某个 Pod 前，要求所有匹配该 Pod 的 PDB 都满足 disruptionsAllowed > 0；
 *   多个 PDB 命中同一 Pod 时取最严格者（全部通过才放行）；
 * - 每驱逐一个 Pod 立即更新健康计数，再判断下一个 Pod，绝不按节点整批删除。
 */
export function simulateDrain(scenario) {
  const { nodes = [], pdbs = [], failedZones = [], drainOrder = [] } = scenario;
  const zoneByNode = new Map(nodes.map((node) => [node.name, node.zone]));
  const failed = new Set(failedZones);

  // 复制 Pod 状态，避免修改调用方输入；应用区域故障
  const pods = scenario.pods.map((pod) => {
    const zone = pod.zone ?? zoneByNode.get(pod.node);
    const zoneDown = zone !== undefined && failed.has(zone);
    return { ...pod, zone, healthy: Boolean(pod.healthy) && !zoneDown, evicted: Boolean(pod.evicted) };
  });

  // 只排空 drainOrder 中列出的节点，未列出的节点保持不动
  const orderedNodes = [...new Set(drainOrder)];

  const steps = [];
  const blocked = new Map(); // podName -> 阻塞详情

  // 每个 PDB 的期望副本数在模拟开始时确定
  const expectedByPdb = new Map(
    pdbs.map((pdb) => [
      pdb.name,
      pods.filter((pod) => !pod.evicted && podMatchesPdb(pod, pdb)).length,
    ]),
  );
  const snapshotOf = (pdb) => pdbSnapshot(pdb, pods, expectedByPdb.get(pdb.name));

  for (const nodeName of orderedNodes) {
    const nodePods = pods.filter((pod) => pod.node === nodeName && !pod.evicted);
    for (const pod of nodePods) {
      const matching = pdbs.filter((pdb) => podMatchesPdb(pod, pdb));
      const snapshots = matching.map(snapshotOf);
      const violators = snapshots.filter((snap) => snap.disruptionsAllowed <= 0);

      if (violators.length === 0) {
        pod.evicted = true;
        steps.push({ node: nodeName, pod: pod.name, action: 'evicted' });
        blocked.delete(pod.name);
      } else {
        const detail = {
          pod: pod.name,
          node: nodeName,
          controller: pod.controller ?? null,
          labels: pod.labels ?? {},
          healthy: pod.healthy,
          blockingPdbs: violators,
          unblockConditions: violators.map(describeUnblock),
        };
        blocked.set(pod.name, detail);
        steps.push({
          node: nodeName,
          pod: pod.name,
          action: 'blocked',
          blockingPdbs: violators.map((snap) => snap.name),
        });
      }
    }
  }

  return {
    steps,
    evicted: pods.filter((pod) => pod.evicted).map((pod) => pod.name),
    blocked: [...blocked.values()],
    pdbStatus: pdbs.map(snapshotOf),
    drainedNodes: orderedNodes.filter((nodeName) =>
      pods.filter((pod) => pod.node === nodeName).every((pod) => pod.evicted),
    ),
  };
}
