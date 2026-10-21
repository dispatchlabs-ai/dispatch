import argparse
import csv
import json
from decimal import Decimal

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("--format", choices=("json", "text"), default="json")
args = parser.parse_args()

with open(args.input, newline="") as source:
    rows = list(csv.DictReader(source))
total = sum(
    (int(row["quantity"]) * Decimal(row["unit_price"]) for row in rows),
    Decimal("0"),
)
units = sum(int(row["quantity"]) for row in rows)
if args.format == "text":
    print(f"total {total:.2f}")
    print(f"units {units}")
else:
    print(json.dumps({"total": f"{total:.2f}", "units": units}))
