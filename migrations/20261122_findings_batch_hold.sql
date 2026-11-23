-- FINDINGSBATCHSTRAND-01: the collector's latest needs-operator decision for an
-- unsettled batch, as {reason,error,heldAt}. NULL when the batch is not held.
-- Health lists a hold only while the batch's error still equals the held error.
ALTER TABLE finding_batches ADD COLUMN hold_json TEXT;
