import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

export async function wecomRefundReady(db: Kysely<Database> | Transaction<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`SELECT
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('collection_facts')
      AND attname = 'refund_reference' AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT attisdropped)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('collection_facts')
      AND tgname = 'collection_facts_validate_refund_reference' AND tgenabled IN ('O', 'A')
      AND NOT tgisinternal AND tgtype = 7 AND tgnargs = 0 AND tgqual IS NULL
      AND tgfoid = to_regprocedure('qintopia_validate_wecom_refund_reference()'))
    AND position('collection_facts_wecom_refund_reference_required' IN
      pg_get_functiondef(to_regprocedure('qintopia_validate_wecom_refund_reference()'))) > 0
    AND position('collection_facts_wecom_refund_reference_shape' IN
      pg_get_functiondef(to_regprocedure('qintopia_validate_wecom_refund_reference()'))) > 0 AS ready`.execute(db);
  return result.rows[0]?.ready === true;
}
