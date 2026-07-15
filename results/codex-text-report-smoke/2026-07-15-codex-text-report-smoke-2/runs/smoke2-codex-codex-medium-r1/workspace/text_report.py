#!/usr/bin/env python3
"""Summarize text input. Complete the functions in this file."""
import argparse
import json
import re
import sys


def summarize(text, limit, prefix=None):
    """Return counts for the non-blank lines in *text*."""
    lines = [line for line in text.splitlines() if line.strip()]
    words = re.findall(r"[A-Za-z]+", "\n".join(lines))

    normalized_prefix = prefix.casefold() if prefix is not None else None
    counts = {}
    for word in words:
        normalized_word = word.lower()
        if normalized_prefix is not None and not normalized_word.startswith(
            normalized_prefix
        ):
            continue
        counts[normalized_word] = counts.get(normalized_word, 0) + 1

    top_words = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        "line_count": len(lines),
        "word_count": sum(counts.values()),
        "top_words": [[word, count] for word, count in top_words[:limit]],
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
