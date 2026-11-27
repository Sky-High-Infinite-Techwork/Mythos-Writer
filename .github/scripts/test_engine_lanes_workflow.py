"""Static guards for mythos-engine-lanes.yml and mythos-engine-keyless.yml.

Run: python3 .github/scripts/test_engine_lanes_workflow.py
"""
from __future__ import annotations

import os
import re
import sys
import unittest

try:
    import yaml
except ImportError:
    yaml = None

HERE = os.path.dirname(os.path.abspath(__file__))
WF = os.path.join(os.path.dirname(HERE), "workflows")
LANES = os.path.join(WF, "mythos-engine-lanes.yml")
KEYLESS = os.path.join(WF, "mythos-engine-keyless.yml")
WRITER = "Sky-High-Infinite-Techwork/Mythos-Writer"


def load(path):
    if yaml is None:
        raise unittest.SkipTest("PyYAML not installed")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return text, yaml.safe_load(text)


class LanesWorkflow(unittest.TestCase):
    def setUp(self):
        self.text, self.doc = load(LANES)

    def test_triggers_are_main_schedule_and_manual_only(self):
        on = self.doc.get("on", self.doc.get(True))
        self.assertIn("schedule", on)
        self.assertIn("workflow_dispatch", on)
        self.assertNotIn("pull_request", on)
        self.assertNotIn("pull_request_target", on)
        self.assertNotIn("push", on)
        # the words may appear in comments ("never pull_request_target")
        on_block = self.text.split("permissions:", 1)[0]
        self.assertNotRegex(on_block, r"(?m)^  pull_request(_target)?\s*:")

    def test_workflow_permissions_start_empty(self):
        self.assertEqual(self.doc["permissions"], {})

    def test_admit_and_every_job_use_the_lanes_environment(self):
        jobs = self.doc["jobs"]
        self.assertEqual(jobs["admit"]["environment"], "lanes")
        for name, job in jobs.items():
            if name == "admit":
                continue
            self.assertEqual(job.get("environment"), "lanes", name)
            cond = " ".join(str(job.get("if") or "").split())
            self.assertIn("needs.admit.outputs.enabled == 'true'", cond, name)
            self.assertIn("github.ref == 'refs/heads/main'", cond, name)

    def test_admit_refuses_any_repo_or_ref_or_event_except_writer_main(self):
        run = jobs_run = None
        for st in self.doc["jobs"]["admit"]["steps"]:
            if st.get("id") == "gate":
                run = st["run"]
        self.assertIsNotNone(run)
        compact = run.replace(" ", "")
        self.assertIn(f'$REPO"!="{WRITER}"', compact)
        self.assertIn('$REF"!="refs/heads/main"', compact)
        self.assertIn("schedule|workflow_dispatch", run)
        self.assertNotIn("pull_request", run)

    def test_checkouts_are_private_repos_with_tokens_never_pr_shas(self):
        for name, job in self.doc["jobs"].items():
            for st in job.get("steps") or []:
                uses = str(st.get("uses") or "")
                if "actions/checkout@" not in uses:
                    continue
                with_ = st.get("with") or {}
                self.assertNotIn("github.event.pull_request", str(with_), (name, st.get("name")))
                repo = with_.get("repository")
                self.assertIn(repo, ("SkyyPlayz/Mythos-Engine", "SkyyPlayz/Mythos-Ops"), (name, st.get("name")))
                if repo == "SkyyPlayz/Mythos-Engine":
                    self.assertEqual(with_.get("token"), "${{ secrets.MYTHOS_ENGINE_READ_TOKEN }}")
                    self.assertEqual(with_.get("persist-credentials"), False)
                if repo == "SkyyPlayz/Mythos-Ops":
                    self.assertEqual(with_.get("token"), "${{ secrets.MYTHOS_DATA_TOKEN }}")

    def test_no_public_artifacts_and_each_keyed_job_prints_only_pass_or_fail(self):
        self.assertNotIn("upload-artifact", self.text)
        self.assertNotIn("download-artifact", self.text)
        jobs = self.doc["jobs"]
        for name in ("tick", "gate", "plan", "publish", "act", "fix", "chain"):
            names = [st.get("name") for st in jobs[name]["steps"]]
            self.assertIn("Public result (pass/fail only)", names, name)
        self.assertIn("Public logs print only pass or fail", self.text)

    def test_no_pull_request_target_job_and_no_secret_echo(self):
        # job keys / on: must not include pull_request_target (comments may warn against it)
        on = self.doc.get("on", self.doc.get(True))
        self.assertNotIn("pull_request_target", on)
        for name, job in self.doc["jobs"].items():
            for st in job.get("steps") or []:
                run = st.get("run") or ""
                self.assertNotIn("echo \"$CONTROL\"", run, name)
                self.assertNotIn("echo \"$CLAUDE", run, name)
                self.assertNotRegex(run, r"echo \"\$\{\{\s*secrets\.")


class KeylessWorkflow(unittest.TestCase):
    def setUp(self):
        self.text, self.doc = load(KEYLESS)

    def test_triggers_and_guards(self):
        on = self.doc.get("on", self.doc.get(True))
        self.assertIn("schedule", on)
        self.assertIn("workflow_dispatch", on)
        self.assertNotIn("pull_request", on)
        self.assertNotIn("pull_request_target", on)
        self.assertEqual(self.doc["permissions"], {})
        tests = self.doc["jobs"]["tests"]
        self.assertEqual(tests["environment"], "lanes")
        cond = " ".join(str(tests["if"]).split())
        self.assertIn("needs.admit.outputs.enabled == 'true'", cond)
        self.assertIn("github.ref == 'refs/heads/main'", cond)

    def test_engine_checkout_is_read_only_and_result_is_pass_or_fail(self):
        tests = self.doc["jobs"]["tests"]
        checkout = next(st for st in tests["steps"] if "actions/checkout@" in str(st.get("uses")))
        self.assertEqual(checkout["with"]["repository"], "SkyyPlayz/Mythos-Engine")
        self.assertEqual(checkout["with"]["token"], "${{ secrets.MYTHOS_ENGINE_READ_TOKEN }}")
        self.assertEqual(checkout["with"]["persist-credentials"], False)
        names = [st.get("name") for st in tests["steps"]]
        self.assertIn("Public result (pass/fail only)", names)
        # no model secrets in this workflow
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", self.text)
        self.assertNotIn("CODEX_AUTH_JSON", self.text)
        self.assertNotIn("MYTHOS_WRITE_TOKEN", self.text)
        self.assertNotIn("upload-artifact", self.text)


if __name__ == "__main__":
    unittest.main()
