-- Receipt of the supported no-continuation decision/branch handoff.
ALTER TABLE finding_batches ADD COLUMN decision_publication_json TEXT;
