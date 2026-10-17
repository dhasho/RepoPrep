import argparse
import csv
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Preview a CSV file")
    parser.add_argument("input", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    with args.input.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    print(f"{len(rows)} rows")
    if not args.dry_run:
        Path("preview.txt").write_text(str(len(rows)), encoding="utf-8")

if __name__ == "__main__":
    main()
