import csv
import re
from pathlib import Path


CSV_PATH = Path("bookdata") / "ALE-spreadsheet-library.csv"


def clean(value):
    return re.sub(r"\s+", " ", (value or "").strip())


def add_label(labels, value):
    value = clean(value)
    if value:
        labels.add(value)


def main():
    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8", newline="")))
    labels = set()

    for row in rows:
        for token in (row.get("Tags") or "").split(","):
            add_label(labels, token)
        for token in (row.get("Categories") or "").split(">"):
            add_label(labels, token)
        add_label(labels, row.get("Parent Category"))
        add_label(labels, row.get("Child Category"))

    # Multi-tag expansion approach discussed:
    # - split "&" compounds
    # - expand specific composite tags to broader tags
    base = list(labels)
    for token in base:
        if "&" in token:
            for part in token.split("&"):
                add_label(labels, part)

    base = list(labels)
    for token in base:
        if token != "Fantasy" and "Fantasy" in token:
            add_label(labels, "Fantasy")
        if token != "Epic" and "Epic" in token:
            add_label(labels, "Epic")
        if token != "Science Fiction" and "Science Fiction" in token:
            add_label(labels, "Science Fiction")
        if token != "LitRPG" and "LitRPG" in token:
            add_label(labels, "LitRPG")

    for label in sorted(labels, key=lambda s: s.lower()):
        print(label)
    print("---")
    print("TOTAL", len(labels))


if __name__ == "__main__":
    main()
