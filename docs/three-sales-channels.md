# Three independent sales channels

Owner-approved 2026-10-28. This supersedes the single-flow restrictions of section 32.

- DIRECT: buyer checks out at the owner's retail price P, without a partner.
- PARTNER: authenticated partner creates a recipient order at agreed R >= owner's D. Remuneration is (R-D)*quantity. This flow has no referral commission.
- REFERRAL: buyer explicitly chooses a signed referral offer for the server cart and checks out at P. The owner-configured fixed commission C is snapshotted per item. Retail price never changes because of a referral.

The catalog defaults to retail, including for partner accounts. The workspace is explicit (?mode=partner) and the authenticated API exposes D, C and promotional assets only with view=partner. All channels share native inventory and the existing cash, delivery, returns, hold and external-payout checks. No payment or transfer integration is implied.

Referral offers last seven days. A new link must not silently replace a populated cart's source. The buyer confirms a replacement, which starts a new cart. Attribution is per purchase, not permanent ownership of a buyer. Own referrals are rejected. Completed checkout clears the cart source; retries return the same immutable order. Revoked, blocked or expired referrals cannot silently become commissionless checkout.

Buyer personal orders and partner sales are separate. Referral partners see their order status/items and commission without recipient phone/address; only creators of manual partner orders can see the recipient details they supplied. Admin sees channel and all operational information.

Historical orders, financial facts and applied migrations remain unchanged. The new migration adds cart context only. Production rollout uses an encrypted verified backup and the existing gated deployment.
