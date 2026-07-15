#!/usr/bin/env python3
"""Summarize text input. Complete the functions in this file."""
import argparse
import json
import re
import sys


def summarize(text, limit, prefix=None):
    raise NotImplementedError("implement summarize")


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
    except OSError as error:
        parser.error(str(error))
    print(json.dumps(summarize(text, args.limit, args.prefix), separators=(",", ":")))


if __name__ == "__main__":
    main()
