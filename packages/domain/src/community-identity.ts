/** Temporary, property-scoped operating estimate until a shared person ID is available.
 * Never used for permissions, money, member ownership, or writes to guest records. */
export interface CommunityIdentityInput {
  id: string;
  orderId: string;
  nickname: string | null;
  fullName: string | null;
  documentNumber: string | null;
}
export interface CommunityIdentity { personKey: string | null; approximate: boolean }

type Person = CommunityIdentityInput & { nick: string; name: string; document: string };
type Group = { key: string; members: Person[] };
const placeholders = new Set(["无", "未知", "不详", "未填", "未填写", "客人", "住客", "测试", "unknown", "null", "none"]);
function label(value: string | null): string {
  const normalized = (value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\p{P}\p{Z}\p{S}\s]/gu, "");
  return placeholders.has(normalized) || /^\d+$/.test(normalized) ? "" : normalized;
}
function person(value: CommunityIdentityInput): Person {
  return { ...value, nick: label(value.nickname), name: label(value.fullName), document: (value.documentNumber ?? "").trim().toUpperCase() };
}

/** One inserted/deleted/substituted character or adjacent transposition. */
function close(a: string, b: string, minimum = 3): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const left = Array.from(a), right = Array.from(b);
  if (Math.min(left.length, right.length) < minimum || Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length === right.length && left[i] === right[j + 1] && left[i + 1] === right[j]) {
      i += 2; j += 2; continue;
    }
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}
function score(a: Person, b: Person): number {
  if (a.document && b.document) return a.document === b.document ? 1000 : 0;
  // Separate roommates must not collapse just because a nickname was copied.
  if (a.orderId === b.orderId && a.id !== b.id) return 0;
  const aName = a.name !== a.nick && Array.from(a.name).length >= 2 ? a.name : "";
  const bName = b.name !== b.nick && Array.from(b.name).length >= 2 ? b.name : "";
  if (aName && bName && !close(aName, bName, 4)) return 0;
  const sameName = !!a.name && a.name === b.name;
  const aLabel = a.nick || a.name, bLabel = b.nick || b.name;
  if (aLabel && aLabel === bLabel) return sameName ? 120 : 100;
  if (a.nick && b.nick && close(a.nick, b.nick, sameName ? 2 : 3)) return sameName ? 95 : 80;
  if (sameName) return 70; // renamed nickname, or only a name was recorded
  return 0;
}
function candidate(group: Group, value: Person): number {
  if (value.document && group.members.some(member => member.document === value.document)) return 1000;
  if (value.document && group.members.some(member => member.document && member.document !== value.document)) return 0;
  if (group.members.some(member => member.orderId === value.orderId && member.id !== value.id)) return 0;
  const named = group.members.filter(member => member.nick || member.name);
  if (!named.length) return 0;
  const scores = named.map(member => score(member, value));
  // Do not let fuzzy A~B~C chains merge A and C when they do not match each other.
  return scores.every(result => result > 0) ? Math.max(...scores) : 0;
}

export function resolveCommunityIdentities(actual: readonly CommunityIdentityInput[], planned: readonly CommunityIdentityInput[] = []): Map<string, CommunityIdentity> {
  const result = new Map<string, CommunityIdentity>();
  const groups: Group[] = [];
  const documents = new Map<string, Group>();
  function process(values: readonly CommunityIdentityInput[]) {
    const rows = values.map(person).sort((a, b) => Number(!!b.document) - Number(!!a.document)
      || Number(!!b.nick && !!b.name) - Number(!!a.nick && !!a.name) || a.id.localeCompare(b.id));
    // Establish document groups before attaching name-only rows, so conflicting IDs
    // remain distinct and ambiguous nickname matches are not resolved by input order.
    for (const value of rows.filter(row => row.document)) {
      let group = documents.get(value.document);
      if (!group) {
        // A planned documented guest may link to an earlier nickname-only stay.
        const ranked = groups.map(item => ({ item, score: candidate(item, value) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
        group = ranked[0] && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].item : undefined;
        if (!group) { group = { key: `document:${value.document}`, members: [] }; groups.push(group); }
        documents.set(value.document, group);
      }
      group.members.push(value);
      result.set(value.id, { personKey: group.key, approximate: !group.key.startsWith("document:") });
    }
    for (const value of rows.filter(row => !row.document)) {
      if (!value.nick && !value.name) { result.set(value.id, { personKey: null, approximate: false }); continue; }
      const ranked = groups.map(item => ({ item, score: candidate(item, value) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
      let group = ranked[0] && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].item : undefined;
      if (!group) { group = { key: `nickname-name:${value.id}`, members: [] }; groups.push(group); }
      group.members.push(value);
      result.set(value.id, { personKey: group.key, approximate: true });
    }
  }
  process(actual);
  // Future bookings can attach to an existing person, but never join two actual groups.
  process(planned);
  return result;
}
