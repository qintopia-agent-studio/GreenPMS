import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function crossRoomUpgradeReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, volatility, language) AS (VALUES
      ('qintopia_cross_room_upgrade_matches(text,text,text,date)', '4b365a2a000b4cc2794c9805de1ea6374e319016b57c0062bb8484664eee40b2', 's', 'sql'),
      ('qintopia_guard_cross_room_upgrade()', 'f0ae1592de3e9177cb416b6a69799bcff528ce2786eda39bc0a2d3b77658ea3b', 'v', 'plpgsql')
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
