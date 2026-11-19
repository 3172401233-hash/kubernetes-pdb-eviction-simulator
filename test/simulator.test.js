import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDrain } from '../src/simulator.js';
import { resolveIntOrPercent, desiredHealthy } from '../src/pdb.js';

function makePods(app, count, { healthy = true, nodes } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${app}-${i + 1}`,
    node: nodes[i % nodes.length],
    labels: { app },
    controller: `deployment/${app}`,
    healthy,
  }));
}

test('单应用：minAvailable 阻止连续驱逐，逐个判断', () => {
  const scenario = {
    nodes: [
      { name: 'node-1', zone: 'zone-a' },
      { name: 'node-2', zone: 'zone-a' },
      { name: 'node-3', 'zone': 'zone-a' },
    ],
    pods: makePods('web', 3, { nodes: ['node-1', 'node-2', 'node-3'] }),
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 2 }],
    drainOrder: ['node-1', 'node-2', 'node-3'],
  };
  const result = simulateDrain(scenario);
  // 只能驱逐 1 个，第二个起被阻塞（健康数会跌破 2）
  assert.deepEqual(result.evicted, ['web-1']);
  assert.equal(result.blocked.length, 2);
  assert.equal(result.blocked[0].pod, 'web-2');
  assert.deepEqual(
    result.blocked[0].blockingPdbs.map((p) => p.name),
    ['web-pdb'],
  );
  assert.match(result.blocked[0].unblockConditions[0], /恢复健康|可驱逐额度/);
  // 阻塞发生在第二个 Pod，而不是把节点上 Pod 一次性删光后才发现
  const actions = result.steps.map((s) => s.action);
  assert.deepEqual(actions, ['evicted', 'blocked', 'blocked']);
});

test('多应用：各自 PDB 独立计算，互不干扰', () => {
  const scenario = {
    nodes: [
      { name: 'node-1', zone: 'zone-a' },
      { name: 'node-2', zone: 'zone-a' },
    ],
    pods: [
      ...makePods('web', 2, { nodes: ['node-1', 'node-2'] }),
      ...makePods('cache', 2, { nodes: ['node-1', 'node-2'] }),
    ],
    pdbs: [
      { name: 'web-pdb', selector: { app: 'web' }, minAvailable: 1 },
      { name: 'cache-pdb', selector: { app: 'cache' }, minAvailable: 1 },
    ],
    drainOrder: ['node-1', 'node-2'],
  };
  const result = simulateDrain(scenario);
  // 每个应用各驱逐 1 个、阻塞 1 个
  assert.deepEqual(result.evicted.sort(), ['cache-1', 'web-1']);
  assert.deepEqual(
    result.blocked.map((b) => b.pod).sort(),
    ['cache-2', 'web-2'],
  );
  const webStatus = result.pdbStatus.find((s) => s.name === 'web-pdb');
  assert.equal(webStatus.currentHealthy, 1);
  assert.equal(webStatus.disruptionsAllowed, 0);
});

test('百分比取整：minAvailable 30% 与 maxUnavailable 50% 均向上取整', () => {
  assert.equal(resolveIntOrPercent('30%', 5), 2); // 1.5 -> 2
  assert.equal(resolveIntOrPercent('50%', 5), 3); // 2.5 -> 3
  assert.equal(resolveIntOrPercent(2, 5), 2);
  assert.equal(desiredHealthy({ name: 'p', minAvailable: '30%' }, 5), 2);
  // maxUnavailable 50% of 5 -> 允许 3 个不可用 -> 至少 2 个健康
  assert.equal(desiredHealthy({ name: 'p', maxUnavailable: '50%' }, 5), 2);

  const scenario = {
    nodes: [{ name: 'node-1', zone: 'zone-a' }, { name: 'node-2', zone: 'zone-a' }],
    pods: makePods('web', 5, { nodes: ['node-1', 'node-2'] }),
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: '30%' }],
    drainOrder: ['node-1', 'node-2'],
  };
  const result = simulateDrain(scenario);
  // 5 个健康，要求 >= 2，可驱逐 3 个
  assert.equal(result.evicted.length, 3);
  assert.equal(result.blocked.length, 2);
});

test('冲突 PDB：多个 PDB 命中同一 Pod 时取最严格者', () => {
  const scenario = {
    nodes: [{ name: 'node-1', zone: 'zone-a' }, { name: 'node-2', zone: 'zone-a' }],
    pods: makePods('web', 3, { nodes: ['node-1', 'node-2'] }),
    pdbs: [
      { name: 'loose-pdb', selector: { app: 'web' }, minAvailable: 1 },
      { name: 'strict-pdb', selector: { app: 'web' }, minAvailable: 3 },
    ],
    drainOrder: ['node-1', 'node-2'],
  };
  const result = simulateDrain(scenario);
  // strict-pdb 要求 3 个全部健康，任何驱逐都被阻塞
  assert.equal(result.evicted.length, 0);
  assert.equal(result.blocked.length, 3);
  assert.deepEqual(result.blocked[0].blockingPdbs.map((p) => p.name), ['strict-pdb']);
});

test('区域故障：故障区域内的 Pod 视为不可用并占用驱逐额度', () => {
  const scenario = {
    nodes: [
      { name: 'node-1', zone: 'zone-a' },
      { name: 'node-2', zone: 'zone-b' },
    ],
    pods: makePods('web', 4, { nodes: ['node-1', 'node-2'] }),
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 2 }],
    failedZones: ['zone-b'],
    drainOrder: ['node-1'],
  };
  const result = simulateDrain(scenario);
  // zone-b 故障后健康数只剩 2，恰好等于 minAvailable，node-1 上任何驱逐都被阻塞
  assert.equal(result.evicted.length, 0);
  assert.equal(result.blocked.length, 2);
  assert.match(result.blocked[0].unblockConditions[0], /PDB web-pdb/);
});

test('部分 Pod 不健康：不健康 Pod 不计入健康数，提前耗尽额度', () => {
  const pods = makePods('web', 4, { nodes: ['node-1', 'node-2'] });
  pods[2].healthy = false; // web-3 已不可用
  const scenario = {
    nodes: [{ name: 'node-1', zone: 'zone-a' }, { name: 'node-2', zone: 'zone-a' }],
    pods,
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 2 }],
    drainOrder: ['node-1', 'node-2'],
  };
  const result = simulateDrain(scenario);
  // 健康数 3，额度 1：只能驱逐 1 个，其余（包括不健康的 web-3）都被阻塞
  assert.equal(result.evicted.length, 1);
  assert.equal(result.blocked.length, 3);
  assert.ok(result.blocked.some((b) => b.pod === 'web-3' && b.healthy === false));
});

test('排空顺序变化：先排健康节点与先排故障节点结果不同', () => {
  const pods = makePods('web', 4, { nodes: ['node-1', 'node-2'] });
  pods[2].healthy = false; // web-3 在 node-1 上（索引 0,2 在 node-1）
  pods[3].healthy = false; // web-4 在 node-2 上
  const base = {
    nodes: [{ name: 'node-1', zone: 'zone-a' }, { name: 'node-2', zone: 'zone-a' }],
    pods,
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 1 }],
  };
  // 健康数 2，额度 1：无论顺序都只能驱逐 1 个，但被驱逐的 Pod 不同
  const first = simulateDrain({ ...base, drainOrder: ['node-1', 'node-2'] });
  const second = simulateDrain({ ...base, drainOrder: ['node-2', 'node-1'] });
  assert.equal(first.evicted.length, 1);
  assert.equal(second.evicted.length, 1);
  assert.notEqual(first.evicted[0], second.evicted[0]);
  assert.equal(first.blocked.length, 3);
  assert.equal(second.blocked.length, 3);
});

test('已驱逐状态：模拟前已 evicted 的 Pod 不参与计算', () => {
  const pods = makePods('web', 3, { nodes: ['node-1', 'node-2'] });
  pods[0].evicted = true; // web-1 已被驱逐
  const scenario = {
    nodes: [{ name: 'node-1', zone: 'zone-a' }, { name: 'node-2', zone: 'zone-a' }],
    pods,
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 1 }],
    drainOrder: ['node-1', 'node-2'],
  };
  const result = simulateDrain(scenario);
  // 剩余 2 个健康 Pod，额度 1：node-1 上的 web-3 先被驱逐，随后 web-2 被阻塞
  assert.deepEqual(result.evicted.sort(), ['web-1', 'web-3']);
  assert.deepEqual(result.blocked.map((b) => b.pod), ['web-2']);
  const status = result.pdbStatus.find((s) => s.name === 'web-pdb');
  assert.equal(status.expectedPods, 2);
});

test('同应用跨节点：全部满足约束时可完整排空', () => {
  const scenario = {
    nodes: [
      { name: 'node-1', zone: 'zone-a' },
      { name: 'node-2', zone: 'zone-b' },
      { name: 'node-3', zone: 'zone-c' },
    ],
    pods: makePods('web', 6, { nodes: ['node-1', 'node-2', 'node-3'] }),
    pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, maxUnavailable: '50%' }],
    drainOrder: ['node-3', 'node-2', 'node-1'],
  };
  const result = simulateDrain(scenario);
  // maxUnavailable 50% of 6 -> 允许 3 个不可用 -> 驱逐 3 个后阻塞
  assert.equal(result.evicted.length, 3);
  assert.equal(result.blocked.length, 3);
  assert.deepEqual(result.drainedNodes, ['node-3']);
  // 阻塞报告包含解除条件
  assert.ok(result.blocked.every((b) => b.unblockConditions.length > 0));
});
