#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { simulateDrain } from './simulator.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node src/cli.js <scenario.json>');
  process.exit(2);
}

const scenario = JSON.parse(await readFile(file, 'utf8'));
const result = simulateDrain(scenario);

for (const step of result.steps) {
  if (step.action === 'evicted') {
    console.log(`[驱逐] 节点 ${step.node} 上的 Pod ${step.pod}`);
  } else {
    console.log(`[阻塞] 节点 ${step.node} 上的 Pod ${step.pod}，被 PDB ${step.blockingPdbs.join(', ')} 阻止`);
  }
}

console.log('\n=== PDB 最终状态 ===');
for (const status of result.pdbStatus) {
  console.log(
    `${status.name}: 健康 ${status.currentHealthy}/${status.expectedPods}，` +
      `要求 ≥ ${status.desiredHealthy}，剩余可驱逐额度 ${status.disruptionsAllowed}`,
  );
}

if (result.blocked.length > 0) {
  console.log('\n=== 无法继续驱逐 ===');
  for (const item of result.blocked) {
    console.log(`Pod ${item.pod}（节点 ${item.node}，控制器 ${item.controller ?? '未知'}）:`);
    for (const condition of item.unblockConditions) {
      console.log(`  解除条件: ${condition}`);
    }
  }
  process.exitCode = 1;
} else {
  console.log('\n所有节点均可按顺序排空。');
}
