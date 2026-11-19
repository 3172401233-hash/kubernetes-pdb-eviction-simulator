// PDB 规则解析：把 minAvailable / maxUnavailable（整数或百分比字符串）
// 归一化为「需要保持健康的 Pod 数」。百分比一律向上取整，与 Kubernetes 一致。

export function resolveIntOrPercent(value, total) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`PDB 数值必须是非负整数，收到: ${value}`);
    }
    return value;
  }
  if (typeof value === 'string' && value.endsWith('%')) {
    const percent = Number(value.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error(`非法百分比: ${value}`);
    }
    return Math.ceil((percent / 100) * total);
  }
  throw new Error(`无法识别的 PDB 数值: ${JSON.stringify(value)}`);
}

// 返回该 PDB 当前要求的最少健康 Pod 数
export function desiredHealthy(pdb, expectedPods) {
  if (pdb.minAvailable !== undefined && pdb.maxUnavailable !== undefined) {
    throw new Error(`PDB ${pdb.name} 不能同时设置 minAvailable 和 maxUnavailable`);
  }
  if (pdb.minAvailable !== undefined) {
    return resolveIntOrPercent(pdb.minAvailable, expectedPods);
  }
  if (pdb.maxUnavailable !== undefined) {
    return expectedPods - resolveIntOrPercent(pdb.maxUnavailable, expectedPods);
  }
  throw new Error(`PDB ${pdb.name} 必须设置 minAvailable 或 maxUnavailable 之一`);
}

export function podMatchesPdb(pod, pdb) {
  const selector = pdb.selector ?? {};
  return Object.entries(selector).every(([key, value]) => pod.labels?.[key] === value);
}
