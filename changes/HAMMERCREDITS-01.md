# HAMMERCREDITS-01 — exhausted Codex account grounding

The shared fleet quota classifier treats a reported exhausted Codex plan meter at or above
100% as exhausted even when the active probe reports success. Closer resolution
uses account exhaustion as hard grounding alongside model caps, selecting an
eligible declared fallback or holding when no fallback is eligible.

Synthetic offline fixtures cover personal and corporate closer fallback, held
dispatch, unknown reset times, and refusal after an elapsed reset estimate. Existing
soft-grounding classifications and account routing remain covered by their
regression files. No configuration or live service state changes.
