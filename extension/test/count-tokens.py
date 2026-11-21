"""Compare Markdown token counts against the same fixture's TypeScript source files."""

import argparse
from pathlib import Path

import tiktoken


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("before_graph", type=Path)
    args = parser.parse_args()

    encoding = tiktoken.get_encoding("o200k_base")

    def count(file):
        return len(encoding.encode_ordinary(file.read_text(encoding="utf-8")))

    source_tokens = sum(
        count(file)
        for file in args.fixture.rglob("*")
        if file.is_file()
        and file.suffix in {".ts", ".tsx"}
        and not {".git", ".next", "node_modules"}.intersection(file.relative_to(args.fixture).parts)
    )
    print("fixture\tbefore_graph\tafter_graph\tsource")
    print(
        args.fixture.name,
        count(args.before_graph),
        count(args.fixture / "codebase_graph.md"),
        source_tokens,
        sep="\t",
    )


if __name__ == "__main__":
    main()
