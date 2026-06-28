import type { DataSource } from 'typeorm';

import type { MemberWeight, WeightVersion } from './custom-index-compute.types';

interface WeightVersionRow {
  id: string | number;
  effective_date: string;
  expire_date: string | null;
  weight_method: string;
}

interface MemberRow {
  version_id: string | number;
  con_code: string;
  weight: string | number;
}

export async function loadWeightVersions(
  dataSource: DataSource,
  customIndexId: string,
): Promise<WeightVersion[]> {
  const versionRows = (await dataSource.query(
    `
      SELECT id, effective_date, expire_date, weight_method
      FROM custom_index_weight_versions
      WHERE custom_index_id = $1
      ORDER BY effective_date ASC
    `,
    [customIndexId],
  )) as WeightVersionRow[];

  if (versionRows.length === 0) {
    return [];
  }

  const versionIds = versionRows.map((r) => Number(r.id));
  const memberRows = (await dataSource.query(
    `
      SELECT version_id, con_code, weight
      FROM custom_index_members
      WHERE version_id = ANY($1::bigint[])
      ORDER BY version_id, con_code
    `,
    [versionIds],
  )) as MemberRow[];

  const membersByVersion = new Map<number, MemberWeight[]>();
  for (const row of memberRows) {
    const vid = Number(row.version_id);
    const list = membersByVersion.get(vid) ?? [];
    list.push({
      conCode: String(row.con_code),
      weight: Number(row.weight),
    });
    membersByVersion.set(vid, list);
  }

  return versionRows.map((row) => {
    const vid = Number(row.id);
    return {
      id: vid,
      effectiveDate: String(row.effective_date),
      expireDate: row.expire_date ? String(row.expire_date) : null,
      weightMethod: String(row.weight_method),
      members: membersByVersion.get(vid) ?? [],
    };
  });
}

export function resolvePitMembers(
  versions: readonly WeightVersion[],
  tradeDate: string,
): readonly MemberWeight[] {
  let active: WeightVersion | null = null;
  for (const version of versions) {
    if (version.effectiveDate > tradeDate) {
      break;
    }
    if (version.expireDate !== null && version.expireDate < tradeDate) {
      continue;
    }
    active = version;
  }
  if (active === null) {
    return [];
  }
  return active.members;
}

export function buildEffectiveDateIndex(
  versions: readonly WeightVersion[],
): Record<string, readonly MemberWeight[]> {
  const index: Record<string, readonly MemberWeight[]> = {};
  for (const version of versions) {
    index[version.effectiveDate] = version.members;
  }
  return index;
}

export function allMemberCodes(versions: readonly WeightVersion[]): Set<string> {
  const codes = new Set<string>();
  for (const version of versions) {
    for (const member of version.members) {
      codes.add(member.conCode);
    }
  }
  return codes;
}

export function validateVersions(versions: readonly WeightVersion[]): void {
  if (versions.length === 0) {
    throw new Error('custom_index 无权重版本链');
  }
  for (const version of versions) {
    if (version.members.length < 2) {
      throw new Error(
        `权重版本 ${version.effectiveDate} 成分不足 2 个（got ${version.members.length}）`,
      );
    }
    const total = version.members.reduce((sum, m) => sum + m.weight, 0);
    if (Math.abs(total - 1.0) > 1e-4) {
      throw new Error(`权重版本 ${version.effectiveDate} 权重总和 ${total} != 1`);
    }
  }
}

export function pitMembersForDates(
  versions: readonly WeightVersion[],
  tradeDates: readonly string[],
): Record<string, readonly MemberWeight[]> {
  const result: Record<string, readonly MemberWeight[]> = {};
  for (const tradeDate of tradeDates) {
    result[tradeDate] = resolvePitMembers(versions, tradeDate);
  }
  return result;
}

export function memberWeightsAsDict(
  members: readonly MemberWeight[],
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const member of members) {
    weights[member.conCode] = member.weight;
  }
  return weights;
}

export function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    return {};
  }
  const normalized: Record<string, number> = {};
  for (const [code, weight] of Object.entries(weights)) {
    normalized[code] = weight / total;
  }
  return normalized;
}

export function emitPitDebug(
  version: WeightVersion | null,
  tradeDate: string,
): Record<string, string | number | null> {
  if (version === null) {
    return { tradeDate, versionId: null };
  }
  return {
    tradeDate,
    versionId: version.id,
    effectiveDate: version.effectiveDate,
    expireDate: version.expireDate,
    memberCount: version.members.length,
  };
}
