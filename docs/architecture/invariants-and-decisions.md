# QinTopia Core Invariants and Decisions

## Domain invariants

1. Service dates are property-local ISO dates in `[arrivalDate, departureDate)`; departure does not claim inventory.
2. Every bed belongs to one room. A whole-room claim conflicts with every child-bed claim on the same service date; different child beds may coexist.
3. Orders and maintenance use the same claim tables and ordered `roomId + serviceDate` row locks.
4. An order has one immutable primary-guest snapshot and exactly one Stay. Every newly created snapshot requires a trimmed, nonblank community nickname; a legacy snapshot may omit the `nickname` JSON key or contain an explicit `null`, and Query/API preserves that original representation honestly. Presentation-only labels such as `历史未记录` are never persisted. Changes append amendments and stay segments.
5. Confirmation locks an immutable pricing-policy version. Any amount change appends a complete revision calculated with that same version.
6. For `YOUMUDAO`, `CTRIP`, and `MEITUAN`, the channel is the customer of the lodging order. The channel reference and the operator-entered target amount are mandatory; the operator-facing label is “本单渠道应结金额”. That target is the order's single contract/current amount, not a guest payment, platform payout batch, or bank receipt.
7. The locked policy base amount/version remain immutable comparison facts. An external-channel target differing from the policy base by no more than 15%, including exactly 15%, needs no explanation; a difference above 15% requires “渠道价格差异说明”. The server compares integer minor units with `abs(target - policyBase) * 100 > policyBase * 15`.
8. A channel price difference is not a manual price adjustment. `WECOM` is a direct-booking source whose channel reference must be `null`; it defaults to the policy amount, and any operator deviation requires a manual-adjustment reason.
9. The target contract amount and first complete pricing revision commit atomically inside `CREATE_ORDER`. The system must never create at the policy amount and then issue `REPRICE_ORDER` to reach the confirmed target.
10. A revision's channel or manual adjustment belongs only to that revision and defaults to zero in the next revision. Any post-creation correction requires a reason and appends history.
11. Membership coverage is a concrete set of date/unit/lot entries. Holds reduce available night units, release restores them, consume records fulfillment without converting the night to cash.
12. Collection, refund, and reversal facts are append-only. Refunds reference a collection in the same order and cannot exceed its un-reversed remaining amount.
13. The three amount fields are arithmetic views over the current pricing revision and signed collection facts. They carry no accounting or payment-settlement meaning.
14. A successful command's domain facts, audit event, command state, and Receipt commit in one PostgreSQL transaction.
15. Membership changes entitlement and settlement treatment only. It neither owns guest identity nor creates a separate guest path; member and non-member orders use the same primary-guest snapshot contract.
16. A split-bed room's daily parent-cell occupancy ratio is `occupied child beds / total physical child beds`. The numerator counts distinct child beds occupied by active normal-order or `FREE_STAY` lodging facts, excluding maintenance, `INTERNAL_USE`, cleaning, and other non-guest sources.
17. Rescheduling a reserved order never deletes, cancels, or recreates it. The same `orderId` and `stayId` remain authoritative while one transaction appends an amendment, an immutable arrangement version, and a complete pricing revision, then migrates inventory claims and still-HELD membership coverage.
18. Every arrival/departure-date change reprices the complete effective, continuous arrangement with the locked policy version. Existing collections only determine an amount-to-collect or refund-reference difference; a date change never collects or refunds money automatically, and already-CONSUMED membership coverage is never restored by an ordinary amendment.
19. Lodging lifecycle permissions depend on both order/stay state and the property business date. Ordinary `CHECK_IN` is limited to the planned arrival date and ordinary `CHECK_OUT` to the planned departure date; future, early, overdue, and retrospective branches fail closed until their dedicated workflows are approved.
20. `stay_segments` are immutable accommodation-arrangement versions, not fulfillment records. Queries and operator UI must distinguish the original arrangement, the effective or final arrangement, typed check-in/check-out results, and arrangement-change history; the maximum segment sequence alone does not prove the guest's actual location.

## Architecture decisions

- A modular TypeScript monolith keeps Web and API on one domain path while preserving package ownership boundaries.
- PostgreSQL day-slot rows and `SELECT ... FOR UPDATE` make room/bed exclusion explicit and testable. Same-room operations briefly serialize; different rooms continue concurrently.
- Opaque credential secrets are generated and retained by the client and hashed before persistence. Neither Preview nor Receipt returns an issue or rotation secret. Immediate database lookup makes expiry, revocation, rotation, subject disablement, and grant narrowing effective on the next request.
- Preview stores normalized input, effect hash, aggregate/inventory/membership basis, subject, property, command type, and expiry. Confirm must repeat the exact `propertyId` and `commandType`, binds to the same subject, locks resources, rebuilds the effect, and rejects any mismatch.
- Idempotency-key recovery is scoped by subject, `propertyId`, and `commandType`; recovery reads never create or update command state.
- A projection or external Base may consume versioned queries but has no core write capability and is never required for readiness.
- Unknown pricing behavior is an error, not a zero, nightly, prorated, or rounded fallback.
- Room-status nickname lists come from immutable primary-guest snapshots. Compact parent cells may truncate visible names, but hover and keyboard focus expose the complete authorized list; redaction remains authoritative and client layout never invents names.
- The current pricing revision remains the single authority for an order's contract amount. Do not add a duplicate “channel expected/actual net amount” column for the same value.
- PMS exposes channel, channel reference, locked policy facts, contract amount, pricing revisions, reasons, fulfillment, corrections, cancellations, and refunds as business facts. Platform settlement batches, bank receipts/statements, cross-order allocations, and financial-reconciliation status belong outside PMS; an external finance agent may combine PMS API facts with those external sources.
- Arrangement history and fulfillment history are separate projections over append-only facts. A segment may overlap or supersede another planned segment and therefore must not be rendered as a chronological actual-stay ledger.
- Check-in/check-out business dates, record times, actors, and results must be returned as typed fulfillment facts. A command record timestamp must not be relabeled as the guest's actual arrival or departure time.

## Reversible assumptions awaiting operating facts

- The demo property uses `Asia/Shanghai`, CNY integer minor units, arrival night charged/claimed, and departure date excluded.
- Member nights are held when an order is confirmed and converted from HELD to CONSUMED when CHECK_IN succeeds. Pre-check-in cancellation, no-show, or removed service dates release HELD nights; CHECK_OUT does not consume them again, and ordinary commands never restore CONSUMED nights.
- `expires_on` is the final eligible service date. This boundary will be replaced if real entitlement contracts demonstrate different semantics.
- Confirming no-show releases its future inventory immediately.
- A refund cannot exceed the un-reversed amount of its referenced collection; it never references or allocates to another order.
- A rolling stay is extended only by an explicit amendment; no scheduled renewal is inferred.

These assumptions are isolated behind commands and golden tests. They are not evidence for weekly, monthly, cross-month, proration, or rounding policy.
