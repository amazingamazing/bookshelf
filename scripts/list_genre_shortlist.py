import csv
import re
from pathlib import Path


CSV_PATH = Path("bookdata") / "ALE-spreadsheet-library.csv"


def clean(value: str) -> str:
    value = re.sub(r"\s+", " ", (value or "").strip())
    return value


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def expand_labels(raw_labels):
    labels = set(raw_labels)
    for label in list(labels):
        # Split "&" compounds (e.g., "Mystery & Thriller")
        # Exception requested: keep "Sword & Sorcery" as a single genre.
        if "&" in label and normalized(label) != normalized("Sword & Sorcery"):
            for part in label.split("&"):
                part = clean(part)
                if part:
                    labels.add(part)

        # Split slash compounds (e.g., "Fantasy/Adventure")
        if "/" in label:
            for part in label.split("/"):
                part = clean(part)
                if part:
                    labels.add(part)

    # Explicit expansion requested: "Epic Fantasy" => "Epic" + "Fantasy"
    for label in list(labels):
        low = label.lower()
        if "epic fantasy" in low:
            labels.add("Epic")
            labels.add("Fantasy")
        if "science fiction" in low:
            labels.add("Science Fiction")
        if "litrpg" in low:
            labels.add("LitRPG")
        if "fantasy" in low:
            labels.add("Fantasy")
        if "thriller" in low:
            labels.add("Thriller")
        if "suspense" in low:
            labels.add("Suspense")
        if "mystery" in low:
            labels.add("Mystery")
        if "romance" in low:
            labels.add("Romance")
    return labels


def is_noise(label):
    low = label.lower()

    # Rule 1: remove award/list/program labels
    noise_fragments = [
        "award", "prize", "best of", "editors select", "essentials", "#booktok",
        "tie-ins", "tie ins"
    ]
    if any(f in low for f in noise_fragments):
        return True

    # Rule 2: remove person/place/time-topic labels that are not genres
    topical_noise = {
        "abraham lincoln", "franklin d. roosevelt", "new york", "montana", "iran",
        "russia", "italy", "china", "england", "middle east", "united states",
        "world", "europe", "americas", "africa", "imperial japan", "soviet union",
        "jewish heritage", "islamic heritage", "anthony award", "hugo award",
        "nebula award", "world fantasy award", "goodreads choice award",
        "los angeles times book prize", "pulitzer prize", "foreword indies book of the year award",
        "audible essentials", "fantasy essentials", "memoir essentials", "series essentials",
        "children's audiobooks", "explore the world"
    }
    if normalized(label) in {normalized(x) for x in topical_noise}:
        return True

    return False


def keep_label(label):
    if not label:
        return False
    if is_noise(label):
        return False

    # Requested cleanup: remove most composite labels with commas/ampersands,
    # except "Sword & Sorcery" which should be preserved.
    if ("&" in label or "," in label) and normalized(label) != normalized("Sword & Sorcery"):
        return False

    # Requested cleanup: drop "literary / literature / fiction" umbrella labels.
    lit_banned = {
        normalized("Fiction"),
        normalized("Genre Fiction"),
        normalized("Literature"),
        normalized("Literature & Fiction"),
        normalized("Literary Fiction")
    }
    if normalized(label) in lit_banned:
        return False

    low = label.lower()

    # Rule 4: keep if it is in our accepted genre roots.
    roots = [
        "action", "adventure", "fantasy", "science fiction", "horror", "mystery",
        "thriller", "suspense", "crime", "romance", "romantasy", "satire", "comedy",
        "historical fiction", "historical", "classics",
        "dystopian", "apocalyptic", "post-apocalyptic", "cyberpunk", "steampunk",
        "space opera", "first contact", "time travel", "paranormal", "urban",
        "supernatural", "superhero", "magic", "myth",
        "fairy tales", "folklore", "mythology", "coming of age", "young adult",
        "teen", "middle grade", "war", "military", "litrpg", "progression fantasy",
        "biography", "memoir", "nonfiction", "history", "science", "philosophy",
        "psychology", "business", "politics", "social sciences", "self-improvement"
    ]
    return normalized(label) == normalized("Sword & Sorcery") or any(root in low for root in roots)


def apply_plural_conflict_rule(labels):
    labels = set(labels)
    for label in list(labels):
        n = normalized(label)
        if not n.endswith("s"):
            continue
        singular = None
        if n.endswith("ies"):
            singular = n[:-3] + "y"
        elif not n.endswith("ss"):
            singular = n[:-1]
        if not singular:
            continue
        if any(normalized(other) == singular for other in labels):
            labels.discard(label)
    return labels


def main():
    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8", newline="")))
    raw_labels = set()
    for row in rows:
        for token in (row.get("Tags") or "").split(","):
            token = clean(token)
            if token:
                raw_labels.add(token)
        for token in (row.get("Categories") or "").split(">"):
            token = clean(token)
            if token:
                raw_labels.add(token)
        for field in ("Parent Category", "Child Category"):
            token = clean(row.get(field) or "")
            if token:
                raw_labels.add(token)

    expanded = expand_labels(raw_labels)
    shortlist = {l for l in expanded if keep_label(l)}
    shortlist = apply_plural_conflict_rule(shortlist)
    shortlist = sorted(shortlist, key=lambda s: s.lower())

    for label in shortlist:
        print(label)
    print("---")
    print("TOTAL", len(shortlist))


if __name__ == "__main__":
    main()
