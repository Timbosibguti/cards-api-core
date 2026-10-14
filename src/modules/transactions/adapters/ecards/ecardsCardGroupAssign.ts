import type { PaymentHttpClient } from '../../../../infra/payment/httpClient.js';
import { getEcardsAccountBaseUrl } from './create.js';

const LIST_PAGE_LIMIT = 50;

interface EcardsCardGroupRow {
  id?: number;
  name?: string | null;
}

interface EcardsCardGroupListResponse {
  data?: { content?: EcardsCardGroupRow[] };
}

export async function fetchEcardsCardGroupList(
  http: PaymentHttpClient,
  accessToken: string,
): Promise<EcardsCardGroupRow[]> {
  const accountBase = getEcardsAccountBaseUrl();
  const all: EcardsCardGroupRow[] = [];
  let offset = 0;
  while (true) {
    const page = await http.request<EcardsCardGroupListResponse>({
      bank: 'ecards',
      method: 'GET',
      baseUrlOverride: accountBase,
      path: '/api/modern/account/v1/user/card-group',
      headers: { Authorization: `Bearer ${accessToken}` },
      query: {
        offset: String(offset),
        limit: String(LIST_PAGE_LIMIT),
        sortBy: 'id',
        sortDirection: 'desc',
      },
    });
    const chunk = page.data?.content ?? [];
    all.push(...chunk);
    if (chunk.length < LIST_PAGE_LIMIT) {
      break;
    }
    offset += LIST_PAGE_LIMIT;
  }
  return all;
}

export function findEcardsCardGroupIdByName(groups: EcardsCardGroupRow[], name: string): number | null {
  const target = name.trim();
  for (const g of groups) {
    if (g?.name != null && String(g.name).trim() === target && g.id != null && Number.isFinite(Number(g.id))) {
      return Number(g.id);
    }
  }
  return null;
}

export async function createEcardsCardGroup(
  http: PaymentHttpClient,
  accessToken: string,
  name: string,
  cardGroupThemeId: number,
): Promise<number> {
  const accountBase = getEcardsAccountBaseUrl();
  const res = await http.request<{ data?: { id?: number } }>({
    bank: 'ecards',
    method: 'POST',
    baseUrlOverride: accountBase,
    path: '/api/modern/account/v1/user/card-group',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { name, cardGroupThemeId },
  });
  const id = res?.data?.id;
  if (id == null || !Number.isFinite(Number(id))) {
    throw new Error('eCards card-group create: missing data.id in response');
  }
  return Number(id);
}

export async function patchEcardsCardCardGroups(
  http: PaymentHttpClient,
  accessToken: string,
  ecardsCardId: number,
  cardGroupIds: number[],
): Promise<void> {
  const accountBase = getEcardsAccountBaseUrl();
  await http.request({
    bank: 'ecards',
    method: 'PATCH',
    baseUrlOverride: accountBase,
    path: `/api/modern/account/v1/user/card/${ecardsCardId}`,
    headers: { Authorization: `Bearer ${accessToken}` },
    body: {
      cardGroupsIds: cardGroupIds,
      optionsRenewable: { enableVelocityControl: false },
    },
  });
}
