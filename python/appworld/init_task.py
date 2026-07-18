#!/usr/bin/env python3
"""初始化或保存 AppWorld task 的 DB 状态(通过 remote apis server)。

读 stdin JSON:
  {"task_id","experiment_name","root","remote_apis_url","mode"}
  mode="init": AppWorld(...).initialize()  (加载 task DBs 到 server,清空 output dir,保存初始状态)
  mode="save": AppWorld(...).save_state()  (持久化 agent 改动到 dbs/*.jsonl)

必须每次在新进程跑(AppWorld 持有进程级状态)。
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
        remote_apis_url = request["remote_apis_url"]
        mode = request["mode"]

        from appworld import update_root
        from appworld.environment import AppWorld
        update_root(root)

        world = AppWorld(
            task_id=task_id,
            experiment_name=experiment_name,
            remote_apis_url=remote_apis_url,
            load_ground_truth=False,
            raise_on_failure=False,
            add_login_shortcut=False,
        )
        if mode == "init":
            # Manually run initialize()'s steps, skipping AppWorld.close_all()
            # which raises a spurious time_freezer_id error on a fresh process.
            world._prepare_directories()
            world._execute_preamble()
            world._set_datetime()
            world._save_state(world.output_db_home_path_on_disk)
            world.save_logs()
            print(json.dumps({
                "ok": True,
                "mode": "init",
                "output_directory": world.output_directory,
            }))
        elif mode == "save":
            world.save_state(world.output_db_home_path_on_disk)
            world.save_logs()
            print(json.dumps({
                "ok": True,
                "mode": "save",
                "output_db_home_path_on_disk": world.output_db_home_path_on_disk,
            }))
        else:
            raise ValueError(f"unknown mode: {mode}")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
