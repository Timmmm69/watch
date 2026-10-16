BEGIN;
-- New confirmations deduplicate transfer identities without reinterpreting legacy references.
ALTER TABLE payouts ADD COLUMN verified_transfer_reference varchar(200);
CREATE UNIQUE INDEX payouts_verified_transfer_reference_key ON payouts(verified_transfer_reference);
ALTER TABLE payouts ADD CONSTRAINT verified_transfer_reference_safe CHECK
  (verified_transfer_reference IS NULL OR (status='PAID' AND verified_transfer_reference=external_reference
    AND verified_transfer_reference ~ '^[A-Za-z][A-Za-z0-9._:-]{0,199}$'
    AND verified_transfer_reference !~ '[0-9]{12}'));
ALTER TABLE order_money_entries ADD CONSTRAINT money_reference_safe CHECK
  (reference ~ '^[A-Za-z][A-Za-z0-9._:-]{0,199}$' AND reference !~ '[0-9]{12}') NOT VALID;
ALTER TABLE order_direct_expenses ADD CONSTRAINT expense_reference_safe CHECK
  (reference ~ '^[A-Za-z][A-Za-z0-9._:-]{0,199}$' AND reference !~ '[0-9]{12}') NOT VALID;
-- T49 could finish a native Return before observed-money writes existed. Preserve its
-- commercial facts and append the missing customer liability; never fabricate a refund.
INSERT INTO customer_obligations(id,order_id,operation_key,kind,amount_minor,return_id,actor_user_id,reason,occurred_at)
SELECT gen_random_uuid(),r.order_id,'return:'||r.id||':refund','RETURN_REFUND',
  sum(oi.customer_unit_price_minor::bigint*ri.quantity)::integer,r.id,r.created_by_admin_user_id,
  'Completed return before money cutover',r.updated_at
FROM returns r JOIN orders o ON o.id=r.order_id JOIN return_items ri ON ri.return_id=r.id
JOIN order_items oi ON oi.id=ri.order_item_id
WHERE r.status='COMPLETED' AND o.economic_regime='DROPSHIP_MARKUP'
  AND NOT EXISTS(SELECT 1 FROM customer_obligations co WHERE co.return_id=r.id AND co.kind='RETURN_REFUND')
GROUP BY r.id HAVING sum(oi.customer_unit_price_minor::bigint*ri.quantity)>0;
COMMIT;
