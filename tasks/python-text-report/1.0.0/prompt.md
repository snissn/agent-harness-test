# Complete `text_report.py`

This workspace contains a small, dependency-free Python command-line tool.
Implement the missing behavior in `text_report.py`; do not add third-party
dependencies.

The command reads UTF-8 text from a path given by `--input` and writes JSON to
stdout. Ignore blank lines. For the remaining lines, output an object with
`line_count`, `word_count`, and `top_words`. A word is a maximal run of ASCII
letters; comparison is case-insensitive. `top_words` is an array of `[word,
count]` pairs sorted by count descending then word ascending, limited by
`--limit` (default 5, positive integer). With `--prefix PREFIX`, count only
words starting with PREFIX, case-insensitively. Invalid arguments and unreadable
input must exit nonzero with a concise message on stderr.

Inspect the repository, implement the tool, and run its tests. Keep output
deterministic and leave the workspace in a working state.
