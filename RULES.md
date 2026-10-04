# Rules register

The plant rules come from the v49 prototype's register (rule IDs H/P/S/M/V/U are kept in code, tests and the viewer). This file records every rule added or changed since, with the UTC time of Sean's message. Rules Claude chose are marked "by Claude".

| Rule | Change | When (UTC) | Sean said |
| --- | --- | --- | --- |
| H8 System 1 trios | A trio (three-batch chain: 3 batches of one SKU on 3 tanks, 1h apart) is filled by **1 or 3 fill POs**, all linked to its 1st batch. Only one of its fill POs fills at a time. Together they empty all three tanks, and each may take a different quantity. The first may start 2h (or its own length, if shorter) before the 3rd batch ends; the hold limit for every fill counts from the end of the 3rd batch; all three tanks stay held until the last fill ends (H4). Was: exactly one fill PO per trio. | 2026-10-04 19:24 | "these chains can be filled into one or three fill POs, but only one PO can be filled out at a time. And each fill will look to empty in total the three tanks but each fill PO can have in theory, different quantities" |
| S (generator) | 25% of trios are drawn with 3 fill POs; a fill's share of the trio's volume follows its fill length (by Claude). `trio_three_fill_pct=0` gives the v49 week exactly. | 2026-10-04 19:24 | |
