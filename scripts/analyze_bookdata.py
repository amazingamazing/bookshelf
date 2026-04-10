import csv
import re
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOKDATA = ROOT / "bookdata"
AUDIBLE_CSV = BOOKDATA / "ALE-spreadsheet-library.csv"
GOODREADS_CSV = BOOKDATA / "goodreads_library_export.csv"


def clean(s):
    return (s or "").strip()


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", clean(s).lower()).strip()


def canonical_series_name(name):
    n = norm(name)
    if not n:
        return n
    n = re.sub(r"\bseries\b$", "", n).strip()
    n = re.sub(r"^the\s+", "", n).strip()
    n = re.sub(r"\ba litrpg adventure\b$", "", n).strip()
    n = re.sub(r"\ba progression fantasy epic\b$", "", n).strip()
    n = re.sub(r"\s+", " ", n).strip()
    return n


def parse_series_from_goodreads_title(title):
    # Examples:
    # "Neuromancer (Sprawl #1)"
    # "Mockingjay (The Hunger Games, #3)"
    # "Prince Caspian (..., #4) (Publication Order, #2)"
    t = clean(title)
    m = re.search(r"\(([^()]+?)(?:,\s*)?#\s*([\d.]+)\)\s*$", t)
    if m:
        return clean(m.group(1)), clean(m.group(2)), "gr_paren_hash"
    m2 = re.search(r"\(([^()]+?)\s+#\s*([\d.]+)\)\s*$", t)
    if m2:
        return clean(m2.group(1)), clean(m2.group(2)), "gr_paren_spacehash"
    return "", "", ""


def parse_series_from_audible_fields(row):
    # Audible file usually has explicit Series and Book Numbers columns.
    s = clean(row.get("Series"))
    n = clean(row.get("Book Numbers"))
    if s:
        # Some rows have multi-part series strings:
        # "Discworld (book 20), Discworld: Death"
        # "The Cosmere (book ), Secret Projects"
        # Keep the first segment as primary.
        if "," in s:
            s = clean(s.split(",")[0])
        # "Noobtown (book 9)" -> "Noobtown", 9
        m = re.match(r"^(.*?)\s*\(\s*book\s+([\d.\-]+)\s*\)\s*$", s, flags=re.I)
        if m:
            return clean(m.group(1)), clean(m.group(2)), "aud_series_col_book"
        return s, n, "aud_series_col"
    return "", "", ""


def parse_series_from_audible_title(row):
    title = clean(row.get("Title"))
    subtitle = clean(row.get("Subtitle"))
    # "The Noob Returns: Noobtown, Book 9"
    m = re.search(r":\s*([^,:]+?),\s*Book\s+([\d.\-]+)\s*$", title, flags=re.I)
    if m:
        return clean(m.group(1)), clean(m.group(2)), "aud_title_colon_book"
    # sometimes subtitle has "Series, Book N"
    m2 = re.search(r"^([^,:]+?),\s*Book\s+([\d.\-]+)\s*$", subtitle, flags=re.I)
    if m2:
        return clean(m2.group(1)), clean(m2.group(2)), "aud_subtitle_book"
    return "", "", ""


def load_csv(path):
    with path.open("r", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main():
    aud = load_csv(AUDIBLE_CSV)
    gr = load_csv(GOODREADS_CSV)

    aud_has_series_col = 0
    aud_has_book_num_col = 0
    aud_parse_source_counts = Counter()
    aud_series_keys = Counter()
    aud_samples_mismatch = []

    for row in aud:
        s1, n1, src1 = parse_series_from_audible_fields(row)
        s2, n2, src2 = parse_series_from_audible_title(row)
        series_name = s1 or s2
        series_num = n1 or n2
        src = src1 or src2 or "none"
        aud_parse_source_counts[src] += 1

        if clean(row.get("Series")):
            aud_has_series_col += 1
        if clean(row.get("Book Numbers")):
            aud_has_book_num_col += 1

        if series_name:
            key = f"{norm(clean(row.get('Authors')))}::{norm(series_name)}"
            aud_series_keys[key] += 1

        # Detect disagreement between series col and title-derived series.
        if s1 and s2 and norm(s1) != norm(s2) and len(aud_samples_mismatch) < 25:
            aud_samples_mismatch.append({
                "title": clean(row.get("Title")),
                "series_col": s1,
                "series_from_title": s2,
                "book_num_col": n1,
                "book_num_from_title": n2,
            })

    gr_parse_source_counts = Counter()
    gr_series_keys = Counter()
    gr_series_keys_canonical = Counter()
    gr_has_series_in_title = 0
    gr_rows_with_parenthetical_but_unparsed = []
    for row in gr:
        s, n, src = parse_series_from_goodreads_title(row.get("Title"))
        gr_parse_source_counts[src or "none"] += 1
        if s:
            gr_has_series_in_title += 1
            key = f"{norm(clean(row.get('Author')))}::{norm(s)}"
            gr_series_keys[key] += 1
            key_c = f"{norm(clean(row.get('Author')))}::{canonical_series_name(s)}"
            gr_series_keys_canonical[key_c] += 1
        elif "(" in clean(row.get("Title")) and ")" in clean(row.get("Title")) and len(gr_rows_with_parenthetical_but_unparsed) < 25:
            gr_rows_with_parenthetical_but_unparsed.append(clean(row.get("Title")))

    shared_series_keys = set(aud_series_keys) & set(gr_series_keys)
    aud_series_keys_canonical = Counter()
    for k, v in aud_series_keys.items():
        author, series = k.split("::", 1)
        aud_series_keys_canonical[f"{author}::{canonical_series_name(series)}"] += v
    shared_series_keys_canonical = set(aud_series_keys_canonical) & set(gr_series_keys_canonical)

    only_aud = sorted(
        [(k, v) for k, v in aud_series_keys.items() if k not in shared_series_keys],
        key=lambda x: x[1],
        reverse=True,
    )
    only_gr = sorted(
        [(k, v) for k, v in gr_series_keys.items() if k not in shared_series_keys],
        key=lambda x: x[1],
        reverse=True,
    )

    print("=== CSV Profile ===")
    print(f"Audible rows: {len(aud)}")
    print(f"Goodreads rows: {len(gr)}")
    print()
    print("=== Audible Series Signals ===")
    print(f"Rows with Series column value: {aud_has_series_col}")
    print(f"Rows with Book Numbers value: {aud_has_book_num_col}")
    print("Parse source counts:", dict(aud_parse_source_counts))
    print(f"Distinct author+series keys: {len(aud_series_keys)}")
    print(f"Series with 2+ books: {sum(1 for c in aud_series_keys.values() if c >= 2)}")
    print()
    print("=== Goodreads Series Signals ===")
    print(f"Rows with parseable series in title: {gr_has_series_in_title}")
    print("Parse source counts:", dict(gr_parse_source_counts))
    print(f"Distinct author+series keys: {len(gr_series_keys)}")
    print(f"Series with 2+ books: {sum(1 for c in gr_series_keys.values() if c >= 2)}")
    print()
    print("=== Cross-Source Overlap (author+series normalized) ===")
    print(f"Shared series keys: {len(shared_series_keys)}")
    print(f"Audible-only series keys: {len(aud_series_keys) - len(shared_series_keys)}")
    print(f"Goodreads-only series keys: {len(gr_series_keys) - len(shared_series_keys)}")
    print()
    print("=== Cross-Source Overlap After Canonicalization ===")
    print(f"Shared canonical series keys: {len(shared_series_keys_canonical)}")
    print(f"Audible-only canonical keys: {len(aud_series_keys_canonical) - len(shared_series_keys_canonical)}")
    print(f"Goodreads-only canonical keys: {len(gr_series_keys_canonical) - len(shared_series_keys_canonical)}")
    print()

    def pretty_key(k):
        author, series = k.split("::", 1)
        return f"{author} -> {series}"

    print("Top Audible-only series (first 15):")
    for k, v in only_aud[:15]:
        print(f"  {v:>3}  {pretty_key(k)}")
    print()
    print("Top Goodreads-only series (first 15):")
    for k, v in only_gr[:15]:
        print(f"  {v:>3}  {pretty_key(k)}")
    print()

    print("=== Audible Internal Mismatches (Series column vs Title pattern) ===")
    if not aud_samples_mismatch:
        print("  none found in sample")
    else:
        for m in aud_samples_mismatch[:15]:
            print(f"  - {m['title']}")
            print(f"      series_col={m['series_col']} | title_series={m['series_from_title']} | num_col={m['book_num_col']} | num_title={m['book_num_from_title']}")
    print()

    print("=== Goodreads Parenthetical but Unparsed (sample) ===")
    for t in gr_rows_with_parenthetical_but_unparsed[:15]:
        print(f"  - {t}")


if __name__ == "__main__":
    main()
