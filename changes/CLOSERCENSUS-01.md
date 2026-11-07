# CLOSERCENSUS-01

Retain pending closer candidates across slow watcher passes for six hours from
their latest attempt. Record the first capacity deferral, clear pending state on
dispatch or terminal PR observation, and exclude candidates already holding an
active launch. The adaptive cap now sees deferred work beyond the former
ten-minute census. Capacity defaults, admission, leases and merge authority are
unchanged.
Known active owners also retire legacy census markers during observation, so
pre-existing launch entries do not count as pending demand after rollout.

Oldest-first deferred retry on slot release remains a follow-up: the watcher
routes posted reviews through separate discovery and maintenance handlers, so
wiring a durable retry queue is beyond the small scheduling hook in this fix.
