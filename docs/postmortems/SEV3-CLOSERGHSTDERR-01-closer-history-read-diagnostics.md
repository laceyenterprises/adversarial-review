# SEV3 closer history reads lost GitHub error evidence

## Impact

A history read could exhaust its retries near the end of a closer run and
leave the pull request open. The generic child exit code made a temporary
service error look the same as missing or inaccessible Git history.

## Cause and reproduction

The history child reported its exit code separately from its output. An
opaque exit code gave the retry policy too little evidence to classify the
failure. The close controller also replaced the failed history helper's
structured output with a generic stop.

In a synthetic fixture, a fake `gh` exits 1 with `HTTP/2.0 502 Bad Gateway`
on its first three blob reads, then returns valid JSON on the fourth. A
second fixture returns `HTTP/2.0 404 Not Found` with token-shaped stderr.
Both failure responses have the same process exit code.

## Correction and verification

The reader now uses the included response status and retry timing, retains
a redacted stderr tail, and allows transient object reads up to five
attempts within the shared deadline. The closer records the class and
number of attempts. An exhausted 502 reaches the watcher's inconclusive
retry path. A 404 stops on its first read and remains a counted failure.

Offline fixtures cover recovery on the fourth request, a secondary rate
limit with `Retry-After`, permanent failure, redaction, stop audit fields,
and the controller's release of its synthetic lease before exit.
