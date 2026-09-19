import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function crossRoomUpgradeReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, volatility, language) AS (VALUES
      ('qintopia_cross_room_upgrade_matches(text,text,text,date)', 'e36279b8612cdca0468975eb9c30c5b0606414e31109c974ce96a4735550a186', 's', 'sql'),
      ('qintopia_guard_cross_room_upgrade()', 'be8f99775246ceb56758807722a57dfe242ea57dbc9d1f389dd3dc75793a36fa', 'v', 'plpgsql')
    )
    SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc p ON p.oid = to_regprocedure(expected.signature)
      LEFT JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') <> body_hash
        OR p.prosecdef OR p.provolatile::text <> volatility OR p.prokind <> 'f' OR l.lanname <> language
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        OR p.proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
    ) AND EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = 'amendments'::regclass
        AND tgname = 'cross_room_upgrade_evidence_guard' AND tgenabled IN ('O', 'A')
        AND pg_get_triggerdef(oid) = 'CREATE CONSTRAINT TRIGGER cross_room_upgrade_evidence_guard AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_cross_room_upgrade()'
    )
    AND has_function_privilege('qintopia_runtime', 'qintopia_cross_room_upgrade_matches(text,text,text,date)', 'EXECUTE')
    AND NOT has_function_privilege('public', 'qintopia_cross_room_upgrade_matches(text,text,text,date)', 'EXECUTE')
    AND NOT has_function_privilege('public', 'qintopia_guard_cross_room_upgrade()', 'EXECUTE') AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
