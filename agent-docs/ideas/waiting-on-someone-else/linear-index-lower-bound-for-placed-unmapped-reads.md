---
name: Linear-index lower bound for placed-unmapped reads
description: htslib walks the lower bound back when a reference has placed-unmapped reads; bam-js uses the entry as is, so an unmapped read alone in its chunk could be pruned. Pick up if a report shows a missing unmapped read.
---

htslib builds the linear index from mapped reads only, and when a reference has
placed-unmapped reads it walks the lower bound back to an earlier entry
(`hts.c:3496`). bam-js uses the entry as is, so an unmapped read that sits alone
in its chunk just before a window's first mapped read could be pruned. Across
every BAI fixture, querying with and without the lower bound returned the same
records in every window. Leave it unless a report turns up.
