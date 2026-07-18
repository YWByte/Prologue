#!/usr/bin/env python3
"""读 stdin JSON {task_id, experiment_name, root},调 evaluate_task,stdout 输出 to_dict()。

必须每次在新进程跑(AppWorld 持有进程级 DB 缓存)。
成功: prints {"success","difficulty","num_tests","passes","failures"} and exits 0.
失败: prints {"error": "...", "traceback": "..."} and exits 1.
"""
import json
import sys
import traceback


def main() -> int:
    try:
        request = json.loads(sys.stdin.readline())
        task_id = request["task_id"]
        experiment_name = request["experiment_name"]
        root = request["root"]
        from appworld import update_root, evaluate_task
        update_root(root)
        tracker = evaluate_task(
            task_id=task_id,
            experiment_name=experiment_name,
            suppress_errors=True,
            save_report=True,
        )
        print(json.dumps(tracker.to_dict()))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
