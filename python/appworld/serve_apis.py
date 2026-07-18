#!/usr/bin/env python3
"""appworld serve apis 薄包装。Args: --root <path> --port <n>。被 TS 父进程 SIGTERM 终止。"""
import argparse
import sys

from appworld import update_root
from appworld.serve.apis import run as run_apis


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    update_root(args.root)
    run_apis(port=args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
