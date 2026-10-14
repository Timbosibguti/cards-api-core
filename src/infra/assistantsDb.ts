import type { PoolClient } from 'pg';

/**
 * Возвращает список email помощников (Media-buyer assistant) для баера (Media-buyer).
 * Основано на логике из mqtt_otp_transactions_service (finance1_ext).
 */
export async function getAssistantsByBuyer(syncClient: PoolClient, buyerEmail: string): Promise<string[]> {
  const res = await syncClient.query<{ email: string | null }>(
    `SELECT DISTINCT assistant.email
       FROM finance1_ext.employees buyer
       INNER JOIN finance1_ext.employee_groups buyer_groups ON buyer.id = buyer_groups.employee_id
       INNER JOIN finance1_ext.groups buyer_group ON buyer_groups.group_id = buyer_group.id
       INNER JOIN finance1_ext.employee_managers em ON buyer.id = em.manager_id
       INNER JOIN finance1_ext.employees assistant ON em.employee_id = assistant.id
       INNER JOIN finance1_ext.employee_groups assistant_groups ON assistant.id = assistant_groups.employee_id
       INNER JOIN finance1_ext.groups assistant_group ON assistant_groups.group_id = assistant_group.id
       WHERE buyer.email = $1
         AND buyer_group.name = '(Buying-Dep) Media-buyer'
         AND assistant_group.name = '(Buying-Dep) Media-buyer assistant'
         AND assistant.email IS NOT NULL`,
    [buyerEmail],
  );

  return res.rows
    .map((r) => (r.email ?? '').trim())
    .filter((email): email is string => email.length > 0);
}

