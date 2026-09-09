import { useEffect, useState } from "react";
import { api } from "./api";
import type { MemberDto } from "./types";

/** Bounded, property-scoped lookup. A selected identity is independent of search pages. */
export function useMemberChoices(propertyId: string, query: string, selectedId: string, enabled: boolean, selectedOnly = false) {
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState({ key: "", cursor: "" });
  const [state, setState] = useState<{ key: string; members: MemberDto[]; nextCursor: string | null; loading: boolean; error?: unknown }>({ key: "", members: [], nextCursor: null, loading: false });
  const key = JSON.stringify([propertyId, query, selectedId, enabled, selectedOnly]);
  const cursor = page.key === key ? page.cursor : "";
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const controller = new AbortController();
    const debounce = window.setTimeout(() => {
      const timeout = window.setTimeout(() => controller.abort(new Error("会员读取超时，请重试")), 12_000);
      setState((prior) => ({ key, members: prior.key === key ? prior.members : [], nextCursor: null, loading: true }));
      Promise.all([
        selectedOnly ? Promise.resolve({ members: [], nextCursor: null }) : api.members(propertyId, query, { hasContract: true, pageSize: 25, ...(cursor ? { beforeId: cursor } : {}), signal: controller.signal }),
        selectedId ? api.members(propertyId, undefined, { hasContract: true, memberId: selectedId, signal: controller.signal }) : Promise.resolve({ members: [] })
      ]).then(([page, selected]) => {
        if (!current) return;
        setState((prior) => ({ key, loading: false, nextCursor: page.nextCursor,
          members: [...new Map([...(cursor && prior.key === key ? prior.members : []), ...selected.members.map((row) => row.member), ...page.members.map((row) => row.member)].map((member) => [member.id, member])).values()]
        }));
      }).catch((error) => {
        if (current) setState((prior) => ({ ...prior, key, loading: false, error: controller.signal.aborted ? controller.signal.reason : error }));
      }).finally(() => window.clearTimeout(timeout));
    }, 250);
    return () => { current = false; window.clearTimeout(debounce); controller.abort(); };
  }, [key, propertyId, query, selectedId, enabled, selectedOnly, cursor, revision]);
  const visible = enabled && state.key === key ? state : { members: [], nextCursor: null, loading: enabled, error: undefined };
  return { ...visible, loadMore: () => setPage({ key, cursor: visible.nextCursor ?? "" }), retry: () => setRevision((value) => value + 1) };
}
