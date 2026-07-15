#!/usr/bin/env python3
"""Summarize text input. Complete the functions in this file."""
import argparse
from collections import Counter
import json
import re


def summarize(text, limit, prefix=None):
    """Return counts for the non-blank lines in *text*."""
    lines = [line for line in text.splitlines() if line.strip()]
    normalized_prefix = prefix.lower() if prefix is not None else None
    counts = Counter()

    for line in lines:
        for match in re.finditer(r"[A-Za-z]+", line):
            word = match.group().lower()
            if normalized_prefix is None or word.startswith(normalized_prefix):
                counts[word] += 1

    top_words = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        "line_count": len(lines),
        "word_count": sum(counts.values()),
        "top_words": [list(item) for item in top_words[:limit]],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Summarize a UTF-8 text file")
    parser.add_argument("--input", required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--prefix")
    args = parser.parse_args(argv)
    if args.limit < 1:
        parser.error("--limit must be positive")
    try:
        with open(args.input, encoding="utf-8") as source:
            text = source.read()
    except (OSError, UnicodeError) as error:
        parser.error(str(error))
    print(json.dumps(summarize(text, args.limit, args.prefix), separators=(",", ":")))


if __name__ == "__main__":
    main()
