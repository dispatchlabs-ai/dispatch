# Coding qualification fixture

`receipt.py` and `items.csv` are the final files produced by the local Codex
task in the [October 21 coding qualification](../../codex-coding-qualification.md).
They contain synthetic receipt data and can be run manually:

```sh
python3 receipt.py items.csv
python3 receipt.py items.csv --format text
```

The observed final outputs were `{"total": "10.15", "units": 8}` and:

```text
total 10.15
units 8
```

To recreate the original task in a disposable workspace, omit the stamp row
from `items.csv` and start with this intentionally incorrect source:

```python
import csv
import json
import sys

with open(sys.argv[1], newline="") as source:
    rows = list(csv.DictReader(source))
total = sum(float(row["unit_price"]) for row in rows)
print(json.dumps({"total": f"{total:.2f}", "units": len(rows)}))
```

Ask the app-managed Codex task to inspect the source and CSV, calculate totals
using quantities and exact decimal prices, count total units, edit the source
and run it. In the same conversation, ask it to add the text format and run both
formats. Quit/reopen the app, return to that task, add the stamp row and run both
formats again. A phrase remembered only in conversation can check continuation.
Correlate each inference request with gateway logs using the
[probe setup](../../codex-probe.md); file outputs alone do not establish routing.
