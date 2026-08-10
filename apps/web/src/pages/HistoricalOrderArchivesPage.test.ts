import { describe, expect, it } from "vitest";
import { emptyArchiveFilters, updateArchiveFilters } from "./HistoricalOrderArchivesPage";

describe("historical archive property-scoped filters", () => {
  it("drops every old-property filter atomically before applying a new-property change", () => {
    const propertyA = updateArchiveFilters(emptyArchiveFilters("property-a"), "property-a", {
      searchInput: "13800138000",
      searchQuery: "13800138000",
      channel: "CTRIP",
      arrivalDate: "2026-03-13"
    });

    expect(updateArchiveFilters(propertyA, "property-b", { kind: "MIGRATED_ARCHIVE" })).toEqual({
      ...emptyArchiveFilters("property-b"),
      kind: "MIGRATED_ARCHIVE"
    });
  });
});
