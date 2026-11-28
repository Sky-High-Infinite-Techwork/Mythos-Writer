"""Guards for mythos-engine-lanes.yml and mythos-engine-keyless.yml (static checks + behaviour tests).

Run: python3 .github/scripts/test_engine_lanes_workflow.py   (CI: ci.yml lint job)
PyYAML is required: without it this file fails (exit 2), it never skips.
Behaviour tests run the workflows' own step scripts under bash with a stub `gh`, fake engine scripts and local git
remotes (url.insteadOf), so nothing here reaches the network or needs a token.
"""
from __future__ import annotations

import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import warnings

try:
    import yaml
except ImportError:
    sys.stderr.write("test_engine_lanes_workflow: PyYAML is required (python3-yaml); failing, not skipping\n")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
WF = os.path.join(os.path.dirname(HERE), "workflows")
LANES = os.path.join(WF, "mythos-engine-lanes.yml")
KEYLESS = os.path.join(WF, "mythos-engine-keyless.yml")
CI = os.path.join(WF, "ci.yml")
# Workflows the no-early-exit-pipe rule scans in full. ci.yml is scanned too, but only its pipefail steps (an
# explicit `shell: bash`, step or defaults, or a `pipefail` in the run): see test_no_early_exit_grep_in_a_pipeline.
GUARDED_WORKFLOWS = (LANES, KEYLESS)
PIPEFAIL_SCOPED_WORKFLOWS = (CI,)
WRITER = "Sky-High-Infinite-Techwork/Mythos-Writer"
ENGINE = "SkyyPlayz/Mythos-Engine"
OPS = "SkyyPlayz/Mythos-Ops"
DATA_EXPR = "${{ vars.MYTHOS_DATA_REPO || 'SkyyPlayz/Mythos-Ops' }}"
DATA_TOKEN = "${{ secrets.MYTHOS_DATA_TOKEN }}"
STATE_JOBS = ("tick", "gate", "plan", "fix")  # jobs that pack and persist engine-state
LOG_JOBS = ("tick", "gate", "plan", "publish", "act", "fix")  # jobs that run engine scripts (+ keyless tests)
LOGIN_STEPS = ("Login checks (Claude, Codex)", "Login check (Claude)")  # fixed-text prints the watcher reads


def load(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return text, yaml.safe_load(text)


LANES_TEXT, LANES_DOC = load(LANES)
KEYLESS_TEXT, KEYLESS_DOC = load(KEYLESS)


def on_of(doc):
    return doc.get("on", doc.get(True))


def all_steps(doc):
    for name, job in doc["jobs"].items():
        for st in job.get("steps") or []:
            yield name, job, st


def step(doc, job, key):
    """The step of `job` whose id is key, or whose name starts with key."""
    for st in doc["jobs"][job]["steps"]:
        if st.get("id") == key or str(st.get("name") or "").startswith(key):
            return st
    raise AssertionError(f"no step {key!r} in {job}")


def cond(job):
    return " ".join(str(job.get("if") or "").split())


def logical_lines(run):
    out, cur = [], ""
    for line in run.splitlines():
        if line.rstrip().endswith("\\"):
            cur += line.rstrip()[:-1] + " "
            continue
        out.append(cur + line)
        cur = ""
    if cur:
        out.append(cur)
    return out

_GREPS = ("grep", "egrep", "fgrep", "rg", "ggrep", "gegrep", "gfgrep", "bsdgrep")
_GREP_ARG_OPTS = ("-e", "-f", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--context", "--after-context",
                  "--before-context", "--directories", "--devices", "--label", "--include", "--exclude",
                  "--exclude-dir", "--color", "--colour", "--binary-files")
_GREP_EXIT_LONG = ("--quiet", "--silent", "--max-count", "--files-with-matches", "--files-without-match")
# every GNU grep long option: getopt takes any unambiguous prefix (--qui, --max=1), so a prefix is read as the option
_GREP_LONG = _GREP_EXIT_LONG + (
    "--after-context", "--basic-regexp", "--before-context", "--binary", "--binary-files", "--byte-offset", "--color",
    "--colour", "--context", "--count", "--dereference-recursive", "--devices", "--directories", "--exclude",
    "--exclude-dir", "--exclude-from", "--extended-regexp", "--file", "--fixed-strings", "--help", "--ignore-case",
    "--include", "--initial-tab", "--invert-match", "--label", "--line-buffered", "--line-number", "--line-regexp",
    "--no-filename", "--no-ignore-case", "--no-messages", "--null", "--null-data", "--only-matching",
    "--perl-regexp", "--recursive", "--regexp", "--text", "--version", "--with-filename", "--word-regexp")
# rg options that take the next word (on top of the grep ones it shares)
_RG_ARG_OPTS = ("-g", "--glob", "-t", "--type", "-T", "--type-not", "-r", "--replace", "-M", "--max-columns",
                "-j", "--threads", "-E", "--encoding", "--iglob", "--pre", "--sort", "--sortr")


def _long_option(name):
    """The GNU grep long option a --word names: itself, or the options it is a prefix of."""
    return (name,) if name in _GREP_LONG else tuple(o for o in _GREP_LONG if o.startswith(name))


def _grep_early_exit_flag(argv_text, prog="grep"):
    """The early-exit option in a grep argv, else None. GNU grep takes options anywhere before `--` (also after the
    pattern), so every word is read: -q, -m, -l or -L in any short cluster, and the long forms."""
    tokens = argv_text.split()
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "--":
            return None
        if t in _GREP_ARG_OPTS or (prog == "rg" and t in _RG_ARG_OPTS):
            i += 2  # an option that takes the next word (that word is never an option)
            continue
        if t.startswith("--"):
            names = _long_option(t.split("=", 1)[0])
            if names and all(n in _GREP_EXIT_LONG for n in names):
                return t
        elif t.startswith("-") and len(t) > 1:
            # Short cluster: -q, -qxF, -Fq, -m, -m1, -l, -lF, -L. An arg option (e, f, A, B, C, d, D) ends the cluster.
            for ch in t[1:]:
                if ch in "qmlL":
                    return t
                if ch in "efABCdD":
                    break
        i += 1
    return None


def _substitutions(line):
    """The bodies of every $( ... ) in line, nested ones too (outermost first)."""
    out, depth, start, i = [], 0, 0, 0
    while i < len(line):
        if line.startswith("$(", i):
            if depth == 0:
                start = i + 2
            depth += 1
            i += 2
            continue
        if depth and line[i] == "(":
            depth += 1
        elif depth and line[i] == ")":
            depth -= 1
            if depth == 0:
                body = line[start:i]
                out.append(body)
                out.extend(_substitutions(body))
        i += 1
    return out


def _strip_substitutions(line):
    """line with every $( ... ) and `...` removed (balanced): their exit status is not the line's condition."""
    out, depth, i = [], 0, 0
    while i < len(line):
        if line.startswith("$(", i):
            depth += 1
            i += 2
            continue
        c = line[i]
        if depth and c == "(":
            depth += 1
        elif depth and c == ")":
            depth -= 1
        elif not depth:
            out.append(c)
        i += 1
    return re.sub(r"`[^`]*`", "", "".join(out))


_ASSIGN_CONDITION = re.compile(
    r"""(?:^|[;\s])(?:if|elif|while|until)\s+(?:!\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z_][A-Za-z0-9_]*=["']?\$\(""")
# bash / sh -c '<script>' (with -o pipefail or not): the script is a step's code too
_SHELL_C = re.compile(r"""(?:^|[\s|;&(])(?:bash|sh|dash|zsh)(?:\s+-[A-Za-z]+(?:\s+[a-z]+)?)*?\s+-[A-Za-z]*c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")""")
_CONDITION = re.compile(r"(?:^|[;\s])(?:if|elif|while|until)\s|&&|\|\||^\s*!\s")
# a sed q / Q command: bare or after a line address (5q, $q), or after a /re/ address (then it must end the command)
_SED_Q = re.compile(r"""(?:^|[;{}'"\s$\d])[qQ]\d*(?=[\s;}'">]|$)|/[qQ]\d*(?=[;}'"]|$)""")


def _pipelines(line):
    """The pipelines of a shell line, each a list of stage texts. Quote-aware: | and |& split stages; ; & && || and
    a closing ) end a pipeline; nothing inside '...' or "..." splits."""
    out, stages, cur, q, i = [], [], "", None, 0
    while i < len(line):
        c = line[i]
        if q:
            cur += c
            if c == q:
                q = None
            elif c == "\\" and q == '"' and i + 1 < len(line):
                cur += line[i + 1]
                i += 1
        elif c in "'\"":
            q = c
            cur += c
        elif c == "\\" and i + 1 < len(line):
            cur += line[i:i + 2]
            i += 1
        elif line.startswith("||", i) or line.startswith("&&", i) or c in ";&)":
            stages.append(cur)
            out.append(stages)
            stages, cur = [], ""
            i += 2 if line.startswith(("||", "&&"), i) else 1
            continue
        elif c == "|":
            stages.append(cur)
            cur = ""
            i += 2 if line.startswith("|&", i) else 1
            continue
        else:
            cur += c
        i += 1
    stages.append(cur)
    out.append(stages)
    return [p for p in out if any(st.strip() for st in p)]


_ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=\S*$")
# wrappers that run the next word as the program: name -> options that take a value
_WRAPPERS = {"command": (), "builtin": (), "exec": ("-a",), "env": ("-u", "--unset", "-C", "--chdir", "-S"),
             "timeout": ("-k", "--kill-after", "-s", "--signal"), "nice": ("-n", "--adjustment"),
             "stdbuf": ("-i", "-o", "-e", "--input", "--output", "--error"), "nohup": (), "time": (),
             "sudo": ("-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p",
                      "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"),
             "busybox": ()}


def _stage_program(stage):
    r"""(program, rest) of a pipeline stage. Leading VAR=val words and wrappers (command, builtin, exec, env, timeout
    with its duration, nice, stdbuf, nohup, time, sudo, busybox) and their options are skipped; a wrapper may be
    path-prefixed, quoted or backslash-escaped (/usr/bin/sudo, /bin/busybox, "env", \timeout). The program word loses
    a leading backslash, quotes and its directory (\grep, "grep", /usr/bin/grep -> grep). ggrep is also grep."""
    words = stage.split()
    i = 0
    while i < len(words):
        w = words[i]
        if w in ("{", "("):  # a group: { grep -q x; } or ( grep -q x )
            i += 1
            continue
        if w[:1] in "({" and len(w) > 1:
            words[i] = w = w[1:]
        if _ASSIGN.match(w):
            i += 1
            continue
        bare = os.path.basename(w.lstrip("\\").strip("'\""))
        if bare in _WRAPPERS:
            takes = _WRAPPERS[bare]
            i += 1
            while i < len(words) and words[i].startswith("-") and words[i] != "-":
                opt = words[i]
                i += 2 if opt in takes else 1
                if opt == "--":
                    break
            if bare == "env":
                while i < len(words) and _ASSIGN.match(words[i]):
                    i += 1
            if bare == "timeout" and i < len(words):
                i += 1  # the duration
            continue
        break
    if i >= len(words):
        return "", ""
    prog = words[i].lstrip("\\").strip("'\"")
    return os.path.basename(prog), " ".join(words[i + 1:])


def _awk_code(rest):
    """awk / perl argv with -v / --assign values dropped and "..." string and /regex/ literals inside '...' programs
    blanked (-v e=exit, print "exit" and /exit/ are not an exit)."""
    rest = re.sub(r"(?:^|(?<=\s))(?:-v\s*|--assign[=\s])\S+", " ", rest)  # -v name=value is data, not code
    def blank(m):
        prog = re.sub(r'"(?:[^"\\]|\\.)*"', '""', m.group(0))
        # a /regex/ where a pattern can start ('/x/', $1 ~ /x/, (/x/), print if /x/): its text is not an exit
        return re.sub(r"((?:^'|[~(,{;!&|]|\b(?:if|unless))\s*)/(?:\\.|[^/\\\n])*/", r"\1//", prog)
    return re.sub(r"'[^']*'", blank, rest)


def _sed_code(rest):
    """sed argv with s/// and y/// commands blanked (their text is not a q command); any delimiter."""
    return re.sub(r"""(?:^|(?<=[;{}'"\s\d$]))[sy]([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImMe\d]*""", " ", rest)


def _is_grep(prog):
    """grep / egrep / fgrep / ggrep / gegrep / gfgrep / bsdgrep / rg, or a variable holding one ($GREP, ${GREP}, $grep_cmd: any name with grep in it)."""
    if prog in _GREPS:
        return True
    m = re.fullmatch(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", prog)
    return bool(m and "grep" in m.group(1).lower())


def _strip_comment(line):
    r"""line without an unquoted # comment (a # at the start or after a blank; $#, ${#x}, \# and quoted # stay).
    A backslash escapes the next char outside quotes and inside "..." (so "a\" # " is still one string)."""
    q, prev, i = None, " ", 0
    while i < len(line):
        c = line[i]
        if c == "\\" and q != "'":
            prev = line[i + 1:i + 2] or c
            i += 2
            continue
        if q:
            if c == q:
                q = None
        elif c in "'\"":
            q = c
        elif c == "#" and prev in " \t":
            return line[:i].rstrip()
        prev = c
        i += 1
    return line


def early_exit_hits(run):
    """Every early-exit pipe the rule finds in a step's run text."""
    return [h for h in map(early_exit_pipe_grep, pipeline_lines(run)) if h]


def pipeline_lines(run):
    r"""The logical lines the no-early-exit-pipe rule reads: comments dropped, then a line ending in \ (continued),
    |, |&, && or || is joined with the next one (a pipe or list continued over lines)."""
    out, cur = [], ""
    for raw in run.splitlines():
        line = _strip_comment(raw).rstrip()
        if line.endswith("\\"):
            cur += line[:-1] + " "
            continue
        if re.search(r"(?:\||\|&|&&)$", line):
            cur += line + " "
            continue
        out.append(cur + line)
        cur = ""
    if cur:
        out.append(cur)
    return out


def _groups_after_pipes(line):
    """Each command of a { ... } or ( ... ) group that reads a pipe, as a synthetic "x | cmd" line: every command of
    the group reads the pipe, not only the first (`| { cat; grep -q x; }`)."""
    out = []
    for m in re.finditer(r"(?:\|&|(?<!\|)\|(?!\|))\s*([({])", line):
        opener = m.group(1)
        closer = "}" if opener == "{" else ")"
        depth, q, k = 0, None, m.start(1)
        while k < len(line):
            c = line[k]
            if c == "\\" and q != "'":
                k += 2
                continue
            if q:
                if c == q:
                    q = None
            elif c in "'\"":
                q = c
            elif c == opener:
                depth += 1
            elif c == closer:
                depth -= 1
                if depth == 0:
                    break
            k += 1
        body = line[m.start(1) + 1:k]
        for cmd in re.split(r";|&&|\|\||\n", body):
            if cmd.strip():
                out.append("x | " + cmd.strip())
    return out


def early_exit_pipe_grep(line):
    r"""An early-exit reader in a pipeline, else None. Under pipefail it can SIGPIPE the writer, and a condition on the
    pipeline then reads false.
    - grep / egrep / fgrep (also wrapped, \grep, "grep", /usr/bin/grep, $GREP) after `|` or `|&` with -q, --quiet,
      --silent, -m, --max-count, -l, -L or the long forms, anywhere in its argv; also inside any $( ) (quoted or
      nested) and as any command of a { } / ( ) group the pipe feeds: (flag, stage). rg too; sudo / busybox are
      wrappers (path-prefixed too: /usr/bin/sudo, /bin/busybox, /usr/bin/env); ggrep, gegrep, gfgrep and bsdgrep
      count as grep; a GNU long-option prefix
      (--qui, --max=1) counts; a bash/sh -c '...' script is read the same way.
    - a `| while` / `| until` loop on a line with a break.
    - head, read, `awk`/`perl ... exit` or `sed ... q` in a pipeline that is a condition (if / elif / while / until,
      !, && / ||), outside $( ) or inside one (nested too) assigned in the condition: (program, line)."""
    for m in _SHELL_C.finditer(line):
        body = m.group(1) if m.group(1) is not None else re.sub(r"\\(.)", r"\1", m.group(2))
        hit = early_exit_pipe_grep(body)
        if hit:
            return hit
    subs = _substitutions(line)
    texts = [line] + subs
    texts += [g for t in texts for g in _groups_after_pipes(t)]
    for pipeline in [p for text in texts for p in _pipelines(text)]:
        for stage in pipeline[1:]:
            prog, rest = _stage_program(stage)
            if _is_grep(prog):
                flag = _grep_early_exit_flag(rest, prog)
                if flag:
                    return flag, f"{prog} {rest}"
            if prog in ("while", "until") and re.search(r"\bbreak\b", line):
                return "loop break", line  # `| while read -r l; do ...; break; done` stops reading early
    bare = _strip_substitutions(line)
    if not _CONDITION.search(bare):
        return None
    # `if v="$(a | head -1)"`: the assignment's status is the substitution's, so its pipeline is the condition too
    scans = [bare] + (subs if _ASSIGN_CONDITION.search(line) else [])
    scans += [g for t in scans for g in _groups_after_pipes(t)]
    for pipeline in [p for text in scans for p in _pipelines(text)]:
        for stage in pipeline[1:]:
            prog, rest = _stage_program(stage)
            if prog in ("head", "read"):
                return prog, line
            if prog in ("awk", "gawk", "mawk", "perl") and re.search(r"\bexit\b", _awk_code(rest)):
                return f"{prog} exit", line
            if prog == "sed" and _SED_Q.search(_sed_code(rest)):
                return "sed q", line
    return None


def pipefail_steps(doc):
    """Steps of a workflow that run bash with pipefail: `shell: bash` (GitHub runs it as bash -eo pipefail; the
    default is bash -e) or a custom shell string with pipefail, on the step, the job's or the workflow's defaults,
    or a pipefail in the run text."""
    wf_shell = ((doc.get("defaults") or {}).get("run") or {}).get("shell")
    for name, job, st in all_steps(doc):
        shell = st.get("shell") or ((job.get("defaults") or {}).get("run") or {}).get("shell") or wf_shell
        shell = str(shell or "")
        run = str(st.get("run") or "")
        if run and (shell == "bash" or "pipefail" in shell or "pipefail" in run):
            yield name, job, st


def between(text, begin, end):
    i, j = text.index(begin), text.index(end)
    return text[i:j + len(end)]


# ---------------------------------------------------------------- sandbox for behaviour tests
GH_STUB = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_GH_LOG"], "a") as f:
    f.write(" ".join(args) + "\n")
url = next((a for a in args if a.startswith("repos/")), "")
def out(key):
    rc = int(os.environ.get(key + "_RC", "0"))
    if rc:
        sys.stderr.write("gh: Not Found (HTTP 404)\n"); sys.exit(rc)
    sys.stdout.write(os.environ.get(key, ""))
if "/actions/variables" in url:
    out("FAKE_GH_VARS")
elif "/actions/workflows/" in url:
    wf = url.split("/actions/workflows/")[1].split("/")[0]
    if not os.path.isfile(os.path.join(os.environ["FAKE_WF_DIR"], wf)):
        sys.stderr.write("gh: Not Found (HTTP 404)\n"); sys.exit(1)
    if "status=in_progress" in url:
        out("FAKE_GH_RUNS")
    else:
        out("FAKE_GH_NONE")
elif "/jobs" in url:
    out("FAKE_GH_JOBS")
else:
    sys.exit(9)
'''

# Engine's engine_state.py CLI contract (scripts/engine_state.py main: apply takes no --root and writes to
# MYTHOS_DATA_ROOT; exit 2 refused, 3 conflict). Files under data/<producer>/ belong to that producer.
FAKE_STATE = r'''#!/usr/bin/env python3
import argparse, json, os, shutil, subprocess, sys
ap = argparse.ArgumentParser()
sub = ap.add_subparsers(dest="cmd", required=True)
p = sub.add_parser("pack"); p.add_argument("--root", required=True); p.add_argument("--base", required=True)
p.add_argument("--out", required=True); p.add_argument("--producer", default="gate")
p = sub.add_parser("apply"); p.add_argument("--delta", required=True); p.add_argument("--producer", default="gate")
p = sub.add_parser("list"); p.add_argument("--root", required=True); p.add_argument("--producer", default="engine")
p.add_argument("-z", action="store_true")
p = sub.add_parser("wake"); p.add_argument("--root", required=True); p.add_argument("--job", required=True)
a = ap.parse_args()
def mine(rel, prod):
    return rel.startswith(f"data/{prod}/")
if a.cmd == "pack":
    os.makedirs(a.out, exist_ok=True)
    names = subprocess.run(["git", "-C", a.root, "ls-files", "-mo", "--exclude-standard"], capture_output=True,
                           text=True, check=True).stdout.split()
    names += subprocess.run(["git", "-C", a.root, "diff", "--name-only", a.base], capture_output=True, text=True,
                            check=True).stdout.split()
    ents = []
    for i, rel in enumerate(sorted(set(n for n in names if mine(n, a.producer)))):
        data = open(os.path.join(a.root, rel), "rb").read()
        kind = "append" if rel.endswith(".jsonl") else "replace"
        if kind == "append":
            old = subprocess.run(["git", "-C", a.root, "show", f"{a.base}:{rel}"], capture_output=True).stdout
            if not data.startswith(old):
                print("engine_state pack: refused: rewritten log"); sys.exit(3)
            data = data[len(old):]
        open(os.path.join(a.out, f"blob-{i}"), "wb").write(data)
        ents.append({"path": rel, "blob": f"blob-{i}", "kind": kind})
    json.dump({"entries": ents}, open(os.path.join(a.out, "manifest.json"), "w"))
    print(f"engine_state pack ({a.producer}): {len(ents)} PRIVATE-PACK-PATHS")
elif a.cmd == "apply":
    root = os.environ.get("MYTHOS_DATA_ROOT")
    if not root:
        print("engine_state apply: refused: MYTHOS_DATA_ROOT unset"); sys.exit(2)
    man = os.path.join(a.delta, "manifest.json")
    if not os.path.isfile(man):
        print("engine_state apply: refused: no delta"); sys.exit(2)
    for e in json.load(open(man))["entries"]:
        dst = os.path.join(root, e["path"]); os.makedirs(os.path.dirname(dst), exist_ok=True)
        blob = open(os.path.join(a.delta, e["blob"]), "rb").read()
        if e.get("kind") == "append":  # blind append, as Engine's apply (no de-dup)
            with open(dst, "ab") as f:
                f.write(blob)
        else:
            open(dst, "wb").write(blob)
    print("engine_state apply: PRIVATE-APPLY-PATHS")
    sys.exit(int(os.environ.get("FAKE_APPLY_RC", "0")))
elif a.cmd == "list":
    got = []
    for d, _, fs in os.walk(os.path.join(a.root, "data")):
        for f in fs:
            rel = os.path.relpath(os.path.join(d, f), a.root)
            if a.producer == "engine" or mine(rel, a.producer):
                got.append(rel)
    sys.stdout.write("".join(r + ("\0" if a.z else "\n") for r in sorted(got)))
elif a.cmd == "wake":
    print("::warning title=Engine WAKE (x)::ALERT PRIVATE-WAKE-TEXT")
'''

# Any other engine script: prints private text on both streams, plus the lines a step parses.
FAKE_SCRIPT = r'''#!/usr/bin/env python3
import os, sys
name = os.path.basename(sys.argv[0])
sys.stdout.write(f"PRIVATE-STDOUT {name} verdict text\n")
sys.stderr.write(f"PRIVATE-STDERR {name}\n")
sys.stdout.write("::error title=Claude login failed::PRIVATE-ANNOTATION-BODY\n")
for line in os.environ.get("FAKE_LINES", "").split("|"):
    if line:
        print(line)
sys.exit(int(os.environ.get("FAKE_RC", "0")))
'''


class Box:
    """A temp workspace: stub gh on PATH, fake code/scripts, GITHUB_OUTPUT/ENV files, local git config."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="lanes-test-")
        self.bin = os.path.join(self.root, "bin")
        os.makedirs(self.bin)
        gh = os.path.join(self.bin, "gh")
        with open(gh, "w") as f:
            f.write(GH_STUB.replace("/usr/bin/env python3", sys.executable, 1))
        os.chmod(gh, 0o755)
        self.sleeps = os.path.join(self.root, "sleep-log")
        with open(os.path.join(self.bin, "sleep"), "w") as f:  # backoff is recorded, never waited
            f.write(f'#!/bin/sh\necho "$1" >> {self.sleeps}\n')
        os.chmod(os.path.join(self.bin, "sleep"), 0o755)
        scripts = os.path.join(self.root, "code", "scripts")
        os.makedirs(os.path.join(scripts, "watch"))
        os.makedirs(os.path.join(scripts, "tests"))
        with open(os.path.join(scripts, "engine_state.py"), "w") as f:
            f.write(FAKE_STATE)
        for n in ("nogrok_final_gate.py", "nogrok_engine_plan.py", "nogrok_engine_proof.py", "nogrok_engine_arm.py",
                  "nogrok_flow_step.py", "nogrok_gate_publish.py", "nogrok_autofix.py", "engine_host.py",
                  "actions_runtime.py", "electron_cache.py", "watch/brother_watch.py", "tests/run_suite_clean.py"):
            with open(os.path.join(scripts, n), "w") as f:
                f.write(FAKE_SCRIPT)
        # keyless runs from inside the Engine checkout (working-directory: code)
        self.out = os.path.join(self.root, "gh-output")
        self.envf = os.path.join(self.root, "gh-env")
        self.ghlog = os.path.join(self.root, "gh-log")
        self.log = os.path.join(self.root, "lanes-log")
        os.makedirs(self.log, mode=0o700)
        self.tmp = os.path.join(self.root, "runner-temp")
        os.makedirs(self.tmp)
        self.gitconfig = os.path.join(self.root, "gitconfig")
        with open(self.gitconfig, "w") as f:
            f.write("[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n"
                    "[protocol \"file\"]\n\tallow = always\n[advice]\n\tdetachedHead = false\n")
        for p in (self.out, self.envf, self.ghlog):
            open(p, "w").close()

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def git(self, *args, cwd=None, check=True):
        return subprocess.run(["git", *args], cwd=cwd or self.root, env=self.env({}), capture_output=True, text=True,
                              check=check)

    def remote(self, name, repo):
        """A bare repo standing in for https://github.com/<repo>.git (url.insteadOf, no network)."""
        bare = os.path.join(self.root, name + ".git")
        subprocess.run(["git", "init", "-q", "--bare", bare], check=True, env=self.env({}))
        with open(self.gitconfig, "a") as f:
            f.write(f'[url "file://{bare}"]\n\tinsteadOf = https://github.com/{repo}.git\n')
        return bare

    def env(self, extra):
        e = {
            "PATH": self.bin + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": self.root, "GIT_CONFIG_GLOBAL": self.gitconfig, "GIT_CONFIG_NOSYSTEM": "1",
            "GITHUB_OUTPUT": self.out, "GITHUB_ENV": self.envf, "RUNNER_TEMP": self.tmp, "LANES_LOG": self.log,
            "FAKE_GH_LOG": self.ghlog, "FAKE_WF_DIR": WF, "PY": sys.executable, "LANG": "C.UTF-8",
            "GITHUB_WORKSPACE": self.root,
        }
        e.update(extra)
        return e

    def bash(self, script, extra=None, cwd=None, flags=("-e",)):
        self.assert_no_expr(script)
        path = os.path.join(self.root, "step.sh")
        with open(path, "w") as f:
            f.write(script)
        return subprocess.run(["bash", "--noprofile", "--norc", *flags, path], cwd=cwd or self.root,
                              env=self.env(extra or {}), capture_output=True, text=True, timeout=120)

    def run_step(self, st, extra=None, job_env=None):
        env = dict(job_env or {})
        env.update({k: str(v) for k, v in (st.get("env") or {}).items() if "${{" not in str(v)})
        env.update(extra or {})
        cwd = os.path.join(self.root, st["working-directory"]) if st.get("working-directory") else self.root
        flags = ("-eo", "pipefail") if st.get("shell") == "bash" else ("-e",)
        return self.bash(st["run"], env, cwd=cwd, flags=flags)

    @staticmethod
    def assert_no_expr(script):
        if "${{" in script:
            raise AssertionError("a behaviour-tested run block must not inline ${{ }} expressions")

    def outputs(self):
        got = {}
        for line in open(self.out).read().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                got[k] = v
        return got

    def logs_text(self):
        text = ""
        for n in sorted(os.listdir(self.log)):
            text += open(os.path.join(self.log, n), errors="replace").read()
        return text


class Sandboxed(unittest.TestCase):
    def setUp(self):
        self.box = Box()
        self.addCleanup(self.box.close)


# ================================================================ static: triggers, environment, admit guards
class LanesStatic(unittest.TestCase):
    doc, text = LANES_DOC, LANES_TEXT

    def test_triggers_are_main_schedule_and_manual_only(self):
        on = on_of(self.doc)
        self.assertEqual(set(on), {"schedule", "workflow_dispatch"})
        on_block = self.text.split("\npermissions:", 1)[0]
        self.assertNotRegex(on_block, r"(?m)^  (pull_request(_target)?|push)\s*:")

    def test_workflow_permissions_start_empty(self):
        self.assertEqual(self.doc["permissions"], {})

    def test_no_workflow_level_concurrency_and_per_job_groups(self):
        self.assertNotIn("concurrency", self.doc)  # H5: a 350-min gate must not queue every other stage
        for name in ("tick", "gate", "plan", "act", "fix"):
            c = self.doc["jobs"][name].get("concurrency") or {}
            self.assertEqual(c.get("group"), f"mythos-engine-{name}", name)
            self.assertIs(c.get("cancel-in-progress"), False, name)

    def test_admit_and_every_job_use_the_lanes_environment(self):
        jobs = self.doc["jobs"]
        self.assertEqual(jobs["admit"]["environment"], "lanes")
        for name, job in jobs.items():
            if name == "admit":
                continue
            self.assertEqual(job.get("environment"), "lanes", name)
            c = cond(job)
            self.assertIn("needs.admit.outputs.enabled == 'true'", c, name)
            self.assertIn("github.ref == 'refs/heads/main'", c, name)

    def test_admit_reads_no_variable_silently(self):
        run = step(self.doc, "admit", "gate")["run"]
        block = between(run, "# ADMIT-BEGIN", "# ADMIT-END")
        self.assertNotIn("|| true", block)
        self.assertNotRegex(block, r"(?m)^\s*exit 0\s*$(?![\s\S]*enabled=true)")
        self.assertIn("::error", block)

    def test_tick_takes_mode_and_pr_from_admit_only(self):
        st = step(self.doc, "tick", "mode")
        self.assertEqual(st["env"]["IN_MODE"], "${{ needs.admit.outputs.mode }}")
        self.assertEqual(st["env"]["IN_PR"], "${{ needs.admit.outputs.pr }}")
        self.assertNotIn("=~", st["run"])  # one validator (admit)
        self.assertNotIn("inputs.", json.dumps(self.doc["jobs"]["tick"]))

    def test_no_secret_echo(self):
        for name, _, st in all_steps(self.doc):
            run = st.get("run") or ""
            self.assertNotRegex(run, r"echo \"?\$(CONTROL|DATA_TOKEN|CLAUDE|MYTHOS_WRITE_TOKEN)", name)
            self.assertNotRegex(run, r"\$\{\{\s*secrets\.", (name, st.get("name")))


# ================================================================ static: checkouts, tokens, data repo (F1, Probe 5)
class CheckoutsAndTokens(unittest.TestCase):
    def checkouts(self, doc):
        for name, job, st in all_steps(doc):
            if "actions/checkout@" in str(st.get("uses") or ""):
                yield name, st, st.get("with") or {}

    def test_every_checkout_keeps_no_credentials(self):
        for doc in (LANES_DOC, KEYLESS_DOC):
            for name, st, w in self.checkouts(doc):
                self.assertIs(w.get("persist-credentials"), False, (name, st.get("name")))
                self.assertNotIn("github.event.pull_request", str(w), (name, st.get("name")))

    def test_checkout_repos_paths_and_tokens_are_fixed(self):
        for doc in (LANES_DOC, KEYLESS_DOC):
            for name, st, w in self.checkouts(doc):
                repo, path = w.get("repository"), w.get("path")
                if repo == ENGINE:  # Engine is only ever code, read-only
                    self.assertEqual(path, "code", (name, st.get("name")))
                    self.assertEqual(w.get("ref"), "main")
                    self.assertEqual(w.get("token"), "${{ secrets.MYTHOS_ENGINE_READ_TOKEN }}")
                elif repo == "${{ env.DATA_REPO }}":
                    self.assertIn(path, ("state", "notes"), (name, st.get("name")))
                    self.assertEqual(w.get("token"), DATA_TOKEN)
                else:
                    self.fail(f"unexpected checkout repo {repo!r} in {name} {st.get('name')}")

    def test_state_checkouts_are_the_data_repo_engine_state_never_engine(self):
        seen = set()
        for name, st, w in self.checkouts(LANES_DOC):
            if w.get("path") == "state":
                seen.add(name)
                self.assertEqual(w.get("repository"), "${{ env.DATA_REPO }}", name)
                self.assertEqual(w.get("ref"), "engine-state", name)
                self.assertEqual(w.get("token"), DATA_TOKEN, name)
            if w.get("path") == "notes":
                self.assertEqual(w.get("ref"), "main", name)
        self.assertEqual(seen, {"tick", "gate", "plan", "publish", "act", "fix"})

    def test_data_repo_defaults_to_ops_and_never_falls_back_to_engine(self):
        for doc in (LANES_DOC, KEYLESS_DOC):
            self.assertEqual(doc["env"]["DATA_REPO"], DATA_EXPR)
        self.assertEqual(LANES_DOC["env"]["MYTHOS_DATA_REPO"], DATA_EXPR)
        notes_jobs = {n for n, st, w in self.checkouts(LANES_DOC) if w.get("path") == "notes"}
        self.assertEqual(notes_jobs, {"gate", "plan", "fix"})
        self.assertIn("MYTHOS_NOTES_ROOT=$GITHUB_WORKSPACE/notes", LANES_TEXT)
        for text in (LANES_TEXT, KEYLESS_TEXT):
            self.assertIn('remote add origin "https://github.com/$DATA_REPO.git"', text)

    def test_data_token_only_in_checkouts_and_the_push_steps(self):
        for doc in (LANES_DOC, KEYLESS_DOC):
            holders = []
            for name, _, st in all_steps(doc):
                env = st.get("env") or {}
                for k, v in env.items():
                    if str(v) == "${{ secrets.MYTHOS_DATA_TOKEN != '' }}":
                        continue  # a presence check (true/false), never the value
                    if "MYTHOS_DATA_TOKEN" in str(v):
                        holders.append((name, st.get("id")))
                        self.assertEqual(k, "DATA_TOKEN")
                        self.assertIn(st.get("id"), ("persist", "privlog"), (name, st.get("name")))
                        run = st["run"]
                        self.assertNotIn("nogrok_", run)  # never next to a model or PR-code step
                        self.assertIn("-c credential.helper= ", run)
                        self.assertIn('echo "password=$DATA_TOKEN"', run)
                        self.assertNotIn("extraheader", run)
                        self.assertNotRegex(run, r"https://[^\"\s]*@")  # never in a remote URL
                if "MYTHOS_DATA_TOKEN" in str(st.get("with") or {}):
                    self.assertIn("actions/checkout@", str(st.get("uses")))
            self.assertNotIn("MYTHOS_DATA_TOKEN", str(doc.get("env") or {}))  # workflow level: every step would hold it
            for name, job in doc["jobs"].items():
                self.assertNotIn("MYTHOS_DATA_TOKEN", str(job.get("env") or {}), name)
            self.assertTrue(holders)


# ================================================================ static: lanes wiring (H1-H5)
class Wiring(unittest.TestCase):
    jobs = LANES_DOC["jobs"]

    def test_in_flight_check_reads_this_workflow(self):
        run = step(LANES_DOC, "tick", "busy")["run"]
        m = re.search(r"\bwf=(\S+)", run)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), os.path.basename(LANES))
        self.assertTrue(os.path.isfile(os.path.join(WF, m.group(1))))
        self.assertIn("actions/workflows/$wf/runs", run)
        for stage in ("gate", "plan", "fix"):
            self.assertIn(stage, self.jobs)
            self.assertNotIn("name", self.jobs[stage])  # the API job name is the id the check greps
            self.assertIn(f"grep -x {stage} >/dev/null", run)
        self.assertNotIn("persist-tick", run)

    def test_pack_and_persist_share_one_delta_dir_per_job(self):
        names = set()
        for job in STATE_JOBS:
            d = self.jobs[job]["env"]["DELTA_NAME"]
            self.assertEqual(d, f"{job}-delta")
            names.add(d)
            pack = step(LANES_DOC, job, "pack")["run"]
            self.assertIn('--out "$RUNNER_TEMP/$DELTA_NAME"', pack)
            self.assertIn('"$RUNNER_TEMP/$DELTA_NAME/manifest.json"', pack)
            persist = step(LANES_DOC, job, "persist")["run"]
            self.assertIn('delta="$RUNNER_TEMP/$DELTA_NAME"', persist)
            self.assertIn('--delta "$delta"', persist)
            self.assertEqual(step(LANES_DOC, job, "persist")["env"]["PRODUCER"], job)
            self.assertIn(f"--producer {job} ", pack)
        self.assertEqual(len(names), 4)
        self.assertNotRegex(LANES_TEXT, r"RUNNER_TEMP/(tick-|plan-|fix-|gate-)?delta\b")

    def test_stages_start_only_on_a_positive_not_busy_after_a_good_tick(self):
        for job in ("gate", "plan", "fix"):
            c = cond(self.jobs[job])
            self.assertIn(f"needs.tick.outputs.{job}_busy == 'false'", c, job)
            self.assertNotIn("_busy != 'true'", c, job)
        for job in ("gate", "plan"):
            self.assertIn("needs.tick.result == 'success'", cond(self.jobs[job]), job)
        self.assertEqual(self.jobs["tick"]["outputs"]["fix_busy"], "${{ steps.busy.outputs.fix }}")

    def test_every_persist_step_sets_the_data_root_and_the_run_attempt(self):
        for job in STATE_JOBS:
            env = step(LANES_DOC, job, "persist")["env"]
            self.assertEqual(env.get("MYTHOS_DATA_ROOT"), "${{ github.workspace }}/state", job)
            self.assertTrue(env["RUN_URL"].endswith("/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}"), job)
            self.assertIn('msg="engine: $PRODUCER state ($RUN_URL)"', step(LANES_DOC, job, "persist")["run"])

    def test_persist_is_one_text_with_engines_retry_loop(self):
        texts = {between(step(LANES_DOC, j, "persist")["run"], "# PERSIST-BEGIN", "# PERSIST-END") for j in STATE_JOBS}
        self.assertEqual(len(texts), 1)
        t = texts.pop()
        self.assertIn("for try in 1 2 3 4 5; do", t)
        self.assertEqual(t.count("git -C state clean -ffdxq"), 2)  # after both resets (S7)
        self.assertIn('sleep "$(( try * 3 + RANDOM % 5 ))"', t)
        self.assertIn("MYTHOS_DATA_ROOT", str(step(LANES_DOC, "gate", "persist")["env"]))
        self.assertNotRegex(t, r"engine_state\.py apply [^\n]*--root")  # Engine's apply has no --root
        # S17: git log is captured (a failure is an explicit error), then matched off the text
        self.assertIn('if ! subjects=$(git -C state log -n 50 --format=%s FETCH_HEAD 2>>"$log"); then', t)
        self.assertIn("::error title=Persist::cannot read landed-push subjects from $STATE_BRANCH; the push may have "
                      'landed: check $STATE_BRANCH for \\"$msg\\" before re-running', t)
        self.assertNotRegex(t, r"git -C state log[^\n]*\|\s*grep")

    def test_publish_and_chain_wait_for_pushed_state(self):
        self.assertIn("needs.gate.outputs.pushed == 'true'", cond(self.jobs["publish"]))
        c = cond(self.jobs["chain"])
        for j in ("gate", "plan", "fix"):
            self.assertIn(f"needs.{j}.outputs.changed == 'true' && needs.{j}.outputs.pushed == 'true'", c)
            self.assertEqual(self.jobs[j]["outputs"]["pushed"], "${{ steps.persist.outputs.pushed }}")

    def test_chain_and_fix_behind_engine_switches(self):
        self.assertIn("needs.admit.outputs.chain == 'on'", cond(self.jobs["chain"]))
        self.assertIn("needs.admit.outputs.fix == 'on'", cond(self.jobs["fix"]))
        self.assertEqual(step(LANES_DOC, "tick", "fix")["env"]["FIX_ON"], "${{ needs.admit.outputs.fix }}")
        q = step(LANES_DOC, "chain", "Queue the next engine run")["run"]
        m = re.search(r"gh workflow run (\S+) ", q)
        self.assertEqual(m.group(1), os.path.basename(LANES))
        self.assertIn("-f chained=true", q)
        self.assertIn("chained", on_of(LANES_DOC)["workflow_dispatch"]["inputs"])
        self.assertEqual(self.jobs["admit"]["outputs"]["chain"], "${{ steps.gate.outputs.chain }}")
        self.assertEqual(self.jobs["admit"]["outputs"]["fix"], "${{ steps.gate.outputs.fix }}")

    def test_ci_runs_this_file(self):
        ci = yaml.safe_load(open(CI, encoding="utf-8"))
        runs = [st.get("run") or "" for st in ci["jobs"]["lint"]["steps"]]
        self.assertTrue(any("python3 .github/scripts/test_engine_lanes_workflow.py" in r for r in runs))
        for st in ci["jobs"]["lint"]["steps"]:
            if "test_engine_lanes_workflow" in str(st.get("run")):
                self.assertNotIn("continue-on-error", st)
                self.assertNotIn("if", st)  # an `if:` could switch the guard off (silent skip)
                self.assertNotIn("||", st["run"])

    def test_missing_pyyaml_fails_not_skips(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "yaml.py"), "w") as f:
                f.write("raise ImportError('no yaml here')\n")
            r = subprocess.run([sys.executable, os.path.abspath(__file__)], env=dict(os.environ, PYTHONPATH=d),
                               capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PyYAML is required", r.stderr)


# ================================================================ static: public logs (F2)
INVOKE = re.compile(r'(?:"\$PY"|\$PY|/usr/bin/python3|python3)\s+(?:-u\s+)?(?:code/scripts/\S+\.py|scripts/tests/\S+\.py)')


class PublicLogs(unittest.TestCase):
    def test_every_engine_script_call_writes_to_the_private_log(self):
        for doc in (LANES_DOC, KEYLESS_DOC):
            for name, _, st in all_steps(doc):
                run = st.get("run") or ""
                for line in logical_lines(run):
                    if INVOKE.search(line):
                        ok = re.search(r'>>?"\$LANES_LOG/[a-z0-9-]+\.log"', line) or (
                            re.search(r'>>?"\$log"', line) and re.search(r'(?m)^\s*log="\$LANES_LOG/[a-z0-9-]+\.log"$', run))
                        self.assertTrue(ok, (name, st.get("name"), line))
                if st.get("working-directory") == "code/scripts" and st.get("name") not in LOGIN_STEPS:
                    self.assertIn(') >>"$LANES_LOG/', run, (name, st.get("name")))
                    self.assertRegex(run, r'"\$PY" - (2>>"\$LANES_LOG/\S+" )?<<')
                for bad in ("tee /dev/stderr", "printf '%s\\n' \"$out\"", "cat state", "cat \"$LANES_LOG", "set -x"):
                    self.assertNotIn(bad, run, (name, st.get("name")))

    def test_each_job_saves_its_log_privately_with_one_text(self):
        texts = set()
        for doc, jobs in ((LANES_DOC, LOG_JOBS), (KEYLESS_DOC, ("tests",))):
            for job in jobs:
                steps = doc["jobs"][job]["steps"]
                ids = [s.get("id") for s in steps]
                self.assertIn("privlog", ids, job)
                pl = steps[ids.index("privlog")]
                self.assertEqual(pl["if"], "always()")
                self.assertEqual(steps[-1]["name"], "Public result (pass/fail only)", job)
                self.assertEqual(ids.index("privlog"), len(steps) - 2, job)
                texts.add(between(pl["run"], "# PRIVLOG-BEGIN", "# PRIVLOG-END"))
                first = steps[0]["run"]
                self.assertIn('echo "LANES_LOG=$RUNNER_TEMP/lanes-log" >> "$GITHUB_ENV"', first)
        self.assertEqual(len(texts), 1)
        self.assertIn("Public logs print only pass or fail", LANES_TEXT)

    def test_no_public_artifacts_and_each_job_prints_pass_or_fail(self):
        for text in (LANES_TEXT, KEYLESS_TEXT):
            self.assertNotIn("upload-artifact", text)
            self.assertNotIn("download-artifact", text)
            self.assertNotIn("continue-on-error", text)
        for name in ("tick", "gate", "plan", "publish", "act", "fix", "chain"):
            names = [st.get("name") for st in LANES_DOC["jobs"][name]["steps"]]
            self.assertIn("Public result (pass/fail only)", names, name)


# ================================================================ keyless static
class KeylessStatic(unittest.TestCase):
    def test_triggers_and_guards(self):
        self.assertEqual(set(on_of(KEYLESS_DOC)), {"schedule", "workflow_dispatch"})
        self.assertEqual(KEYLESS_DOC["permissions"], {})
        tests = KEYLESS_DOC["jobs"]["tests"]
        self.assertEqual(tests["environment"], "lanes")
        c = cond(tests)
        self.assertIn("needs.admit.outputs.enabled == 'true'", c)
        self.assertIn("github.ref == 'refs/heads/main'", c)

    def test_engine_checkout_read_only_and_no_model_secrets(self):
        tests = KEYLESS_DOC["jobs"]["tests"]
        checkout = next(st for st in tests["steps"] if "actions/checkout@" in str(st.get("uses")))
        self.assertEqual(checkout["with"]["repository"], ENGINE)
        self.assertEqual(checkout["with"]["token"], "${{ secrets.MYTHOS_ENGINE_READ_TOKEN }}")
        self.assertIs(checkout["with"]["persist-credentials"], False)
        for s in ("CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON", "MYTHOS_WRITE_TOKEN", "MYTHOS_CONTROL_READ_TOKEN"):
            self.assertNotIn(s, KEYLESS_TEXT)
        names = [st.get("name") for st in tests["steps"]]
        self.assertLess(names.index("Secrets present (fail loud, never skip)"),
                        names.index("Check out private Engine (read-only token)"))

    def test_suite_failure_is_never_swallowed(self):
        st = step(KEYLESS_DOC, "tests", "Run the engine test suite")
        self.assertNotIn("continue-on-error", st)
        self.assertNotIn("|| true", st["run"])
        self.assertIn('exit "$rc"', st["run"])


# ================================================================ behaviour: admit (H6, H4, S2, S3)
class AdmitBehaviour(Sandboxed):
    BASE = {"REPO": WRITER, "REF": "refs/heads/main", "EVENT": "schedule", "MODE": "", "PR": "", "CHAINED": "",
            "CONTROL": "ctl-token", "DATA_REPO_VAR": OPS}

    def admit(self, vars_=None, gh_rc=0, **kw):
        env = dict(self.BASE)
        env.update(kw)
        lines = "".join(f"{k}={v}\n" for k, v in (vars_ or {}).items())
        env.update({"FAKE_GH_VARS": lines, "FAKE_GH_VARS_RC": str(gh_rc)})
        st = step(LANES_DOC, "admit", "gate")
        open(self.box.out, "w").close()
        r = self.box.run_step(st, {k: v for k, v in env.items()})
        return r, self.box.outputs()

    LIVE = {"MYTHOS_LANES_HOST": "writer", "MYTHOS_ENGINE_SCHEDULE": "on"}

    def test_rejects_other_repo_ref_event(self):
        for kw in ({"REPO": "someone/fork"}, {"REF": "refs/heads/feature"}, {"REF": "refs/pull/1/merge"},
                   {"EVENT": "pull_request"}, {"EVENT": "pull_request_target"}, {"EVENT": "push"}):
            r, out = self.admit(self.LIVE, **kw)
            self.assertEqual(r.returncode, 1, kw)
            self.assertNotIn("enabled", out, kw)

    def test_missing_control_token_fails_loud(self):
        r, out = self.admit(self.LIVE, CONTROL="")
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error title=Lanes admit::MYTHOS_CONTROL_READ_TOKEN", r.stdout)
        self.assertNotIn("enabled", out)

    def test_failed_variable_read_fails_loud(self):
        r, out = self.admit(self.LIVE, gh_rc=1)
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error title=Lanes admit::cannot read", r.stdout)
        self.assertNotIn("ctl-token", r.stdout + r.stderr)
        self.assertNotIn("enabled", out)

    def test_host_not_writer_is_a_green_no_op(self):
        for v in ({"MYTHOS_LANES_HOST": "engine", "MYTHOS_ENGINE_SCHEDULE": "on"}, {"MYTHOS_ENGINE_SCHEDULE": "on"}):
            r, out = self.admit(v)
            self.assertEqual(r.returncode, 0, v)
            self.assertNotIn("enabled", out)
            self.assertIn("not writer", r.stdout)

    def test_writer_without_data_repo_var_fails(self):
        r, out = self.admit(self.LIVE, DATA_REPO_VAR="")
        self.assertEqual(r.returncode, 1)
        self.assertIn("MYTHOS_DATA_REPO", r.stdout)
        self.assertNotIn("enabled", out)

    def test_schedule_needs_schedule_on(self):
        r, out = self.admit({"MYTHOS_LANES_HOST": "writer", "MYTHOS_ENGINE_SCHEDULE": "off"})
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("enabled", out)
        r, out = self.admit({"MYTHOS_LANES_HOST": "writer"})
        self.assertNotIn("enabled", out)
        r, out = self.admit(self.LIVE)
        self.assertEqual(r.returncode, 0)
        self.assertEqual((out.get("enabled"), out.get("mode")), ("true", "pass"))

    def test_manual_runs_default_dry_run_and_skip_the_schedule_switch(self):
        r, out = self.admit({"MYTHOS_LANES_HOST": "writer"}, EVENT="workflow_dispatch")
        self.assertEqual((r.returncode, out.get("enabled"), out.get("mode")), (0, "true", "dry-run"))
        r, out = self.admit({"MYTHOS_LANES_HOST": "writer"}, EVENT="workflow_dispatch", MODE="selftest", PR="1958")
        self.assertEqual((out.get("mode"), out.get("pr")), ("selftest", "1958"))

    def test_bad_mode_or_pr_rejected(self):
        for kw in ({"MODE": "rm -rf"}, {"PR": "0"}, {"PR": "12a"}, {"PR": "12345678"}, {"PR": "1;id"}):
            r, out = self.admit({"MYTHOS_LANES_HOST": "writer"}, EVENT="workflow_dispatch", **kw)
            self.assertEqual(r.returncode, 1, kw)
            self.assertNotIn("enabled", out, kw)

    def test_chained_run_needs_chain_and_schedule_on(self):
        base = {"MYTHOS_LANES_HOST": "writer"}
        cases = (({"MYTHOS_ENGINE_SCHEDULE": "on"}, None), ({"MYTHOS_ENGINE_CHAIN": "on"}, None),
                 ({"MYTHOS_ENGINE_SCHEDULE": "on", "MYTHOS_ENGINE_CHAIN": "on"}, "true"))
        for extra, want in cases:
            r, out = self.admit(dict(base, **extra), EVENT="workflow_dispatch", MODE="pass", CHAINED="true")
            self.assertEqual(r.returncode, 0, extra)
            self.assertEqual(out.get("enabled"), want, extra)

    def test_chain_and_fix_switches_exact_on_default_off(self):
        r, out = self.admit(self.LIVE)
        self.assertEqual((out.get("chain"), out.get("fix")), ("off", "off"))
        r, out = self.admit(dict(self.LIVE, MYTHOS_ENGINE_CHAIN="ON", MYTHOS_ENGINE_FIX="yes"))
        self.assertEqual((out.get("chain"), out.get("fix")), ("off", "off"))
        r, out = self.admit(dict(self.LIVE, MYTHOS_ENGINE_CHAIN="on", MYTHOS_ENGINE_FIX="on"))
        self.assertEqual((out.get("chain"), out.get("fix")), ("on", "on"))

    def test_keyless_admit_rejects_other_repo_ref_event(self):
        st = step(KEYLESS_DOC, "admit", "gate")
        for kw, rc in (({}, 0), ({"REPO": "x/y"}, 1), ({"REF": "refs/heads/dev"}, 1), ({"EVENT": "pull_request"}, 1)):
            env = {"REPO": WRITER, "REF": "refs/heads/main", "EVENT": "schedule"}
            env.update(kw)
            open(self.box.out, "w").close()
            r = self.box.run_step(st, env)
            self.assertEqual(r.returncode, rc, kw)
            self.assertEqual(self.box.outputs().get("enabled"), "true" if rc == 0 else None, kw)


# ================================================================ behaviour: in-flight check (H1)
class BusyBehaviour(Sandboxed):
    def busy(self, **fake):
        st = step(LANES_DOC, "tick", "busy")
        env = {"REPO": WRITER, "RUN_ID": "100", "GH_TOKEN": "x", "MODE": "pass"}
        env.update(fake)
        open(self.box.out, "w").close()
        return self.box.run_step(st, env), self.box.outputs()

    def test_idle_means_nothing_busy(self):
        r, out = self.busy()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((out["gate"], out["plan"], out["fix"]), ("false", "false", "false"))
        self.assertIn("actions/workflows/mythos-engine-lanes.yml/runs", open(self.box.ghlog).read())

    def test_a_live_gate_elsewhere_holds_only_the_gate(self):
        r, out = self.busy(FAKE_GH_RUNS="77\n", FAKE_GH_JOBS="tick\ngate\n")
        self.assertEqual(r.returncode, 0)
        self.assertEqual((out["gate"], out["plan"], out["fix"]), ("true", "false", "false"))
        r, out = self.busy(FAKE_GH_RUNS="77\n", FAKE_GH_JOBS="plan\nfix\n")
        self.assertEqual((out["gate"], out["plan"], out["fix"]), ("false", "true", "true"))

    def test_unreadable_runs_fail_loud_never_busy(self):
        for fake in ({"FAKE_GH_NONE_RC": "1"}, {"FAKE_GH_RUNS": "77\n", "FAKE_GH_JOBS_RC": "1"}):
            r, out = self.busy(**fake)
            self.assertNotEqual(r.returncode, 0, fake)
            self.assertIn("::error title=In-flight check::", r.stdout)
            # red AND closed: all three stages read as busy even if a job condition forgets tick success (H8)
            self.assertEqual((out.get("gate"), out.get("plan"), out.get("fix")), ("true", "true", "true"), fake)


# ---------------------------------------------------------------- a small evaluator for the jobs' `if:` text
_TOK = re.compile(r"\s*(?:(\'(?:[^']|'')*\')|(==|!=|&&|\|\||!|\(|\))|([A-Za-z_][A-Za-z0-9_.\-]*)(\(\))?)")


def gh_if(expr, ctx, failed=False):
    """Evaluate a GitHub `if:` (the subset these workflows use) against ctx (dotted name -> string). A missing name is
    '' as on GitHub; == and != compare strings case-insensitively; && and || return an operand. failed: an earlier
    step of the job failed (success() is false, failure() is true)."""
    toks, pos, expr = [], 0, expr.strip()
    while pos < len(expr):
        m = _TOK.match(expr, pos)
        if not m or m.end() == pos:
            raise AssertionError(f"cannot parse {expr[pos:]!r}")
        pos = m.end()
        if m.group(1) is not None:
            toks.append(("s", m.group(1)[1:-1].replace("''", "'")))
        elif m.group(2):
            toks.append(("op", m.group(2)))
        elif m.group(4):
            fn = m.group(3)
            if fn not in ("always", "cancelled", "success", "failure"):
                raise AssertionError(f"unknown function {fn}")
            toks.append(("s", {"always": True, "cancelled": False, "success": not failed, "failure": failed}[fn]))
        else:
            name = m.group(3)
            if name in ("true", "false"):
                toks.append(("s", name == "true"))
            else:
                toks.append(("s", ctx.get(name, "")))
    i = 0

    def peek():
        return toks[i] if i < len(toks) else (None, None)

    def take():
        nonlocal i
        i += 1
        return toks[i - 1]

    def primary():
        k, v = take()
        if (k, v) == ("op", "("):
            r = orx()
            assert take() == ("op", ")")
            return r
        if (k, v) == ("op", "!"):
            return not primary()
        assert k == "s", (k, v)
        return v

    def cmp():
        a = primary()
        while peek() in (("op", "=="), ("op", "!=")):
            op = take()[1]
            b = primary()
            eq = str(a).lower() == str(b).lower() if not isinstance(a, bool) and not isinstance(b, bool) else a == b
            a = eq if op == "==" else not eq
        return a

    def andx():
        a = cmp()
        while peek() == ("op", "&&"):
            take()
            b = cmp()
            a = b if a else a
        return a

    def orx():
        a = andx()
        while peek() == ("op", "||"):
            take()
            b = andx()
            a = a if a else b
        return a

    r = orx()
    assert i == len(toks), toks[i:]
    return bool(r)


_STATUS_FN = re.compile(r"\b(?:always|success|failure|cancelled)\s*\(\s*\)")


def job_runs(expr, ctx, needs_ok=True):
    """Whether a job runs. As on GitHub, a job `if:` with no status function gets an implicit success(): it is
    skipped when a job it needs failed."""
    if not _STATUS_FN.search(expr):
        expr = f"success() && ({expr})"
    return gh_if(expr, ctx, failed=not needs_ok)


def step_runs(st, ctx, failed=False):
    """Whether a step runs. As on GitHub, an `if:` with no status function gets an implicit success(): after an
    earlier failure in the job it is skipped."""
    expr = str(st.get("if") or "true")
    if not _STATUS_FN.search(expr):
        expr = f"success() && ({expr})"
    return gh_if(expr, ctx, failed)


class StageConditions(Sandboxed):
    """H9: in every manual mode the tick's outputs must open the gate job; plan and fix only in pass mode; a busy read
    error closes every stage. The tick's own step conditions and the busy step's real script decide the outputs."""

    def tick_outputs(self, mode, failed_before_busy=False, **fake):
        """failed_before_busy: an earlier tick step failed (Gate App key, publish, scan) before the busy step."""
        b = self.box
        sctx = {"steps.mode.outputs.mode": mode}
        tick = LANES_DOC["jobs"]["tick"]
        if gh_if(str(step(LANES_DOC, "tick", "ready")["if"]), sctx):
            sctx["steps.ready.outputs.ok"] = "true"
        for sid, key in (("scan", "work"), ("plan", "plan"), ("fix", "fix")):
            if gh_if(str(step(LANES_DOC, "tick", sid)["if"]), sctx):
                sctx[f"steps.{sid}.outputs.{key}"] = "true"  # there is work of each kind
        tick_ok = not failed_before_busy
        st = step(LANES_DOC, "tick", "busy")
        if step_runs(st, sctx, failed_before_busy):
            open(b.out, "w").close()
            env = {"REPO": WRITER, "RUN_ID": "100", "GH_TOKEN": "x", "MODE": mode}
            env.update(fake)
            r = b.run_step(st, env)
            tick_ok = tick_ok and r.returncode == 0
            for k, v in b.outputs().items():
                sctx[f"steps.busy.outputs.{k}"] = v
        outs = {}
        for k, v in tick["outputs"].items():
            m = re.fullmatch(r"\$\{\{\s*(steps\.[\w.\-]+)\s*\}\}", str(v))
            self.assertIsNotNone(m, (k, v))
            outs[k] = sctx.get(m.group(1), "")
        return outs, tick_ok

    def runs(self, job, outs, tick_ok=True):
        ctx = {"needs.admit.result": "success", "needs.admit.outputs.enabled": "true", "needs.admit.outputs.fix": "on",
               "github.ref": "refs/heads/main", "needs.tick.result": "success" if tick_ok else "failure"}
        ctx.update({f"needs.tick.outputs.{k}": v for k, v in outs.items()})
        return job_runs(str(LANES_DOC["jobs"][job]["if"]), ctx, needs_ok=tick_ok)

    def test_gate_runs_in_every_mode_plan_and_fix_only_in_pass(self):
        want = {"pass": (True, True, True), "dry-run": (True, False, False), "selftest": (True, False, False)}
        for mode, exp in want.items():
            outs, ok = self.tick_outputs(mode)
            self.assertTrue(ok, mode)
            got = tuple(self.runs(j, outs, ok) for j in ("gate", "plan", "fix"))
            self.assertEqual(got, exp, (mode, outs))

    def test_manual_modes_read_nothing(self):
        for mode in ("dry-run", "selftest"):
            open(self.box.ghlog, "w").close()
            outs, ok = self.tick_outputs(mode, FAKE_GH_NONE_RC="1")  # a read would fail: none is made
            self.assertTrue(ok, mode)
            self.assertEqual((outs["gate_busy"], outs["plan_busy"], outs["fix_busy"]), ("false",) * 3, mode)
            self.assertEqual(open(self.box.ghlog).read(), "", mode)

    def test_pass_mode_stays_fail_closed(self):
        for fake in ({"FAKE_GH_NONE_RC": "1"}, {"FAKE_GH_RUNS": "77\n", "FAKE_GH_JOBS_RC": "1"}):
            outs, ok = self.tick_outputs("pass", **fake)
            self.assertFalse(ok, fake)
            self.assertEqual([self.runs(j, outs, ok) for j in ("gate", "plan", "fix")], [False] * 3, fake)
        outs, ok = self.tick_outputs("pass", FAKE_GH_RUNS="77\n", FAKE_GH_JOBS="gate\nfix\n")
        self.assertEqual([self.runs(j, outs, ok) for j in ("gate", "plan", "fix")], [False, True, False])
        # no busy output at all (the check skipped or lost) never opens a stage in pass mode
        outs, ok = self.tick_outputs("pass")
        for j in ("gate", "plan", "fix"):
            self.assertFalse(self.runs(j, dict(outs, **{f"{j}_busy": ""}), ok), j)

    def test_off_and_a_failed_tick_open_nothing(self):
        outs, ok = self.tick_outputs("off")
        self.assertEqual([self.runs(j, outs, ok) for j in ("gate", "plan", "fix")], [False] * 3)
        for mode in ("pass", "dry-run", "selftest"):
            outs, _ = self.tick_outputs(mode)
            self.assertFalse(self.runs("gate", outs, False), mode)
            self.assertFalse(self.runs("plan", outs, False), mode)

    def test_a_tick_that_fails_before_the_busy_step_keeps_fix_closed(self):
        # HARD-I: the header's claim. fix's own `if:` has always() and no tick-success term, so this holds only because
        # the busy step is skipped after an earlier failure (fix_busy stays empty). A status function on it would
        # run it anyway, write all false and open fix after a red tick.
        busy_if = str(step(LANES_DOC, "tick", "busy")["if"])
        self.assertNotRegex(busy_if, _STATUS_FN, "the busy step must keep the implicit success()")
        self.assertIsNone(step(LANES_DOC, "tick", "busy").get("continue-on-error"))
        open(self.box.ghlog, "w").close()
        outs, ok = self.tick_outputs("pass", failed_before_busy=True, FAKE_GH_RUNS="", FAKE_GH_JOBS="")
        self.assertFalse(ok)
        self.assertEqual((outs["gate_busy"], outs["plan_busy"], outs["fix_busy"]), ("", "", ""), outs)
        self.assertEqual(open(self.box.ghlog).read(), "")
        self.assertEqual([self.runs(j, outs, ok) for j in ("gate", "plan", "fix")], [False] * 3)
        # the same tick without the earlier failure does open fix (the case above is not vacuous)
        outs, ok = self.tick_outputs("pass", FAKE_GH_RUNS="", FAKE_GH_JOBS="")
        self.assertTrue(ok)
        self.assertTrue(self.runs("fix", outs, ok))

    def test_a_tick_that_fails_after_the_busy_step_still_lets_fix_run(self):
        # Intended (Probe S20): fix's `if:` has no needs.tick.result term, on purpose. Engine's fix ran after a red
        # tick; this workflow keeps fix closed only when the tick fails before the in-flight check (no positive
        # not-busy, test above). A tick that fails after it (WAKE, pack or its own persist) still lets fix run: fix
        # reads the newest persisted engine-state itself, and a long or failed tick must not block fixes.
        self.assertNotIn("needs.tick.result", cond(LANES_DOC["jobs"]["fix"]))
        # S24 (Probe): both directions. runs() applies GitHub's implicit success() on a job `if:` without a status
        # function, so dropping fix's always() (fix would then skip after a red tick) fails the assertTrue below.
        outs, ok = self.tick_outputs("pass", FAKE_GH_RUNS="", FAKE_GH_JOBS="")
        self.assertTrue(ok)
        self.assertTrue(self.runs("fix", outs, tick_ok=False))  # the tick went red after the check
        self.assertFalse(self.runs("gate", outs, tick_ok=False))
        self.assertFalse(self.runs("plan", outs, tick_ok=False))

    def test_a_not_ready_pass_tick_is_red_and_reads_nothing(self):
        # HARD-J: pass mode with ready != true must end red (never a silent green with every stage closed).
        # S2: and it must not read the API (the busy step needs ready itself, not only the stages).
        st = step(LANES_DOC, "tick", "Not ready fails the tick")
        self.assertIsNone(st.get("continue-on-error"))
        not_ready = {"steps.mode.outputs.mode": "pass", "steps.ready.outputs.ok": "false"}
        self.assertTrue(step_runs(st, not_ready))
        self.assertTrue(step_runs(st, {"steps.mode.outputs.mode": "pass"}))  # ready output missing: still red
        for ctx in ({"steps.mode.outputs.mode": "pass", "steps.ready.outputs.ok": "true"},
                    {"steps.mode.outputs.mode": "dry-run"}, {"steps.mode.outputs.mode": "selftest"},
                    {"steps.mode.outputs.mode": "off"}):
            self.assertFalse(step_runs(st, ctx), ctx)  # never a false red
        r = self.box.run_step(st, {})
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(step_runs(step(LANES_DOC, "tick", "busy"), not_ready), "S2: no API read when not ready")
        self.assertEqual(LANES_DOC["jobs"]["tick"]["outputs"]["ready"], "${{ steps.ready.outputs.ok }}")
        for j in ("gate", "plan", "fix"):
            self.assertFalse(self.runs(j, {"mode": "pass", "ready": "false", "work": "true", "plan": "true",
                                           "fix": "true"}, False), j)

    def test_busy_step_gets_the_mode(self):
        # run_step drops ${{ }} env, so pin it: without MODE the step dies on `set -u` in every mode
        self.assertEqual(step(LANES_DOC, "tick", "busy")["env"]["MODE"], "${{ steps.mode.outputs.mode }}")

    def test_plan_and_fix_need_pass_mode_themselves(self):
        # defence in depth: even if a manual-mode tick reported ready/plan/fix, plan and fix stay closed
        outs, ok = self.tick_outputs("pass")
        for mode in ("dry-run", "selftest", "off"):
            forged = dict(outs, mode=mode)
            self.assertFalse(self.runs("plan", forged, ok), mode)
            self.assertFalse(self.runs("fix", forged, ok), mode)

    def test_evaluator_basics(self):
        c = {"a": "x", "b": ""}
        self.assertTrue(gh_if("a == 'X' && b == ''", c))
        self.assertFalse(gh_if("a != 'x' || !always()", c))
        self.assertTrue(gh_if("!cancelled() && (b == 'y' || a == 'x')", c))
        self.assertFalse(gh_if("missing == 'false'", c))
        # the implicit success() on a job `if:` (S24)
        self.assertTrue(job_runs("a == 'x'", c))
        self.assertFalse(job_runs("a == 'x'", c, needs_ok=False))
        self.assertTrue(job_runs("always() && a == 'x'", c, needs_ok=False))
        self.assertTrue(job_runs("!cancelled() && a == 'x'", c, needs_ok=False))


# ================================================================ behaviour: pack -> persist round trip (H2, H3, F1)
class PersistBehaviour(Sandboxed):
    def setUp(self):
        super().setUp()
        b = self.box
        self.bare = b.remote("data", OPS)
        seed = os.path.join(b.root, "seed")
        b.git("clone", "-q", f"https://github.com/{OPS}.git", seed)
        b.git("checkout", "-q", "--orphan", "engine-state", cwd=seed)
        os.makedirs(os.path.join(seed, "data", "other"))
        with open(os.path.join(seed, "data", "other", "x.json"), "w") as f:
            f.write("{}\n")
        b.git("add", "-A", cwd=seed)
        b.git("commit", "-q", "-m", "seed", cwd=seed)
        b.git("push", "-q", "origin", "HEAD:engine-state", cwd=seed)
        self.seed = seed
        self.state = os.path.join(b.root, "state")
        b.git("clone", "-q", "-b", "engine-state", f"https://github.com/{OPS}.git", self.state)

    def hook(self, reject):
        h = os.path.join(self.bare, "hooks", "pre-receive")
        cnt = os.path.join(self.box.root, "push-count")
        with open(h, "w") as f:
            f.write(f"#!/bin/sh\nn=$(cat {cnt} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {cnt}\n"
                    f"[ $n -gt {reject} ] || {{ echo rejected >&2; exit 1; }}\n")
        os.chmod(h, 0o755)

    def write(self, job, name="new.json", body='{"v": 1}\n'):
        d = os.path.join(self.state, "data", job)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "w") as f:
            f.write(body)

    def pack_and_persist(self, job, extra=None):
        b = self.box
        job_env = dict(LANES_DOC["jobs"][job].get("env") or {})
        base = b.git("rev-parse", "HEAD", cwd=self.state).stdout.strip()
        open(b.out, "w").close()
        r = b.run_step(step(LANES_DOC, job, "pack"), {"BASE": base}, job_env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(b.outputs().get("changed"), "true")
        self.assertNotIn("PRIVATE", r.stdout + r.stderr)
        open(b.out, "w").close()
        env = {"STATE_BRANCH": "engine-state", "RUN_URL": "https://example.invalid/run/1",
               "MYTHOS_DATA_ROOT": self.state, "DATA_TOKEN": "tok-SENTINEL-123"}
        env.update(extra or {})
        return b.run_step(step(LANES_DOC, job, "persist"), env, job_env), b.outputs()

    def origin_has(self, rel):
        r = subprocess.run(["git", "--git-dir", self.bare, "show", f"engine-state:{rel}"], capture_output=True,
                           text=True, env=self.box.env({}))
        return r.returncode == 0

    def test_each_job_round_trips_its_state(self):
        for job in STATE_JOBS:
            with self.subTest(job=job):
                self.box.git("fetch", "-q", "origin", cwd=self.state)
                self.box.git("reset", "-q", "--hard", "origin/engine-state", cwd=self.state)
                self.write(job)
                r, out = self.pack_and_persist(job)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(out.get("pushed"), "true")
                self.assertTrue(self.origin_has(f"data/{job}/new.json"))
                self.assertTrue(self.origin_has("data/other/x.json"))
                self.assertNotIn("PRIVATE", r.stdout + r.stderr)
                self.assertNotIn("tok-SENTINEL", r.stdout + r.stderr)

    def test_rejected_pushes_are_retried_onto_the_newest_state(self):
        # another job pushed after this checkout was made
        with open(os.path.join(self.seed, "data", "other", "y.json"), "w") as f:
            f.write("{}\n")
        self.box.git("add", "-A", cwd=self.seed)
        self.box.git("commit", "-q", "-m", "other job", cwd=self.seed)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.seed)
        self.hook(reject=3)
        self.write("gate")
        r, out = self.pack_and_persist("gate")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(out.get("pushed"), "true")
        self.assertTrue(self.origin_has("data/gate/new.json"))
        self.assertTrue(self.origin_has("data/other/y.json"))
        self.assertEqual(len(open(self.box.sleeps).read().split()), 3)  # one backoff per rejected push

    def origin_text(self, rel):
        return subprocess.run(["git", "--git-dir", self.bare, "show", f"engine-state:{rel}"], capture_output=True,
                              text=True, env=self.box.env({})).stdout

    def test_untracked_files_outside_the_delta_are_never_pushed(self):
        b = self.box
        job_env = LANES_DOC["jobs"]["gate"]["env"]
        self.write("gate")
        base = b.git("rev-parse", "HEAD", cwd=self.state).stdout.strip()
        r = b.run_step(step(LANES_DOC, "gate", "pack"), {"BASE": base}, job_env)
        self.assertEqual(r.returncode, 0)
        self.write("gate", "stray.json", '{"not": "in the delta"}\n')  # written after the pack
        open(b.out, "w").close()
        r = b.run_step(step(LANES_DOC, "gate", "persist"), {"STATE_BRANCH": "engine-state", "RUN_URL": "u",
                       "MYTHOS_DATA_ROOT": self.state, "DATA_TOKEN": "t"}, job_env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(self.origin_has("data/gate/new.json"))
        self.assertFalse(self.origin_has("data/gate/stray.json"))

    def test_a_new_append_file_lands_once(self):
        self.write("gate", "rows.jsonl", '{"a": 1}\n{"a": 2}\n')
        r, out = self.pack_and_persist("gate")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.origin_text("data/gate/rows.jsonl"), '{"a": 1}\n{"a": 2}\n')

    def test_a_new_append_file_lands_once_after_a_retry(self):
        self.hook(reject=1)
        self.write("fix", "rows.jsonl", '{"a": 1}\n')
        r, out = self.pack_and_persist("fix")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.origin_text("data/fix/rows.jsonl"), '{"a": 1}\n')

    def test_a_grown_append_file_gets_only_the_new_lines(self):
        self.write("tick", "rows.jsonl", '{"a": 1}\n')
        self.box.git("add", "-A", cwd=self.state)
        self.box.git("commit", "-q", "-m", "base", cwd=self.state)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.state)
        self.write("tick", "rows.jsonl", '{"a": 1}\n{"a": 2}\n')
        r, out = self.pack_and_persist("tick")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.origin_text("data/tick/rows.jsonl"), '{"a": 1}\n{"a": 2}\n')

    def test_an_earlier_attempts_commit_is_not_taken_as_this_attempts_push(self):
        url1, url2 = "https://example.invalid/run/9/attempts/1", "https://example.invalid/run/9/attempts/2"
        with open(os.path.join(self.seed, "data", "other", "z.json"), "w") as f:
            f.write("{}\n")
        self.box.git("add", "-A", cwd=self.seed)
        self.box.git("commit", "-q", "-m", f"engine: gate state ({url1})", cwd=self.seed)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.seed)
        self.hook(reject=1)
        self.write("gate")
        r, out = self.pack_and_persist("gate", {"RUN_URL": url2})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(self.origin_has("data/gate/new.json"))

    def test_a_landed_push_is_found_under_a_long_history(self):
        # git log writes one subject at a time; the check must read past the match. An early-exit `grep -q` under
        # pipefail makes the writer die of SIGPIPE, so a landed push reads as "not landed" and is applied again.
        for n in range(60):
            self.box.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", f"old {n}",
                         cwd=self.seed)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.seed)
        real = shutil.which("git")
        flag = os.path.join(self.box.root, "push-lied")
        wrapper = os.path.join(self.box.bin, "git")
        with open(wrapper, "w") as f:
            f.write(f'#!/bin/bash\nfor a in "$@"; do\n  if [ "$a" = push ] && [ ! -e {flag} ]; then\n'
                    f'    : > {flag}; {real} "$@"; echo "timed out" >&2; exit 1\n  fi\n'
                    f'  if [ "$a" = log ]; then\n    set -o pipefail\n'
                    f'    {real} "$@" | while IFS= read -r l; do printf "%s\\n" "$l" || exit 141; /bin/sleep 0.02; done\n'
                    f'    exit $?\n  fi\ndone\nexec {real} "$@"\n')
        os.chmod(wrapper, 0o755)
        self.write("fix")
        r, out = self.pack_and_persist("fix")
        os.unlink(wrapper)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(flag))
        self.assertEqual(out.get("pushed"), "true", r.stdout + r.stderr)
        msgs = subprocess.run(["git", "--git-dir", self.bare, "log", "--format=%s", "engine-state"],
                              capture_output=True, text=True, env=self.box.env({})).stdout.splitlines()
        self.assertEqual(msgs.count("engine: fix state (https://example.invalid/run/1)"), 1)

    def clean_fails(self, on_call):
        """A git wrapper whose `clean` fails on call number on_call (1 = the first fetch, 2 = the re-fetch)."""
        real = shutil.which("git")
        cnt = os.path.join(self.box.root, "clean-count")
        wrapper = os.path.join(self.box.bin, "git")
        with open(wrapper, "w") as f:
            f.write(f'#!/bin/bash\nfor a in "$@"; do\n  if [ "$a" = clean ]; then\n'
                    f'    n=$(cat {cnt} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {cnt}\n'
                    f'    if [ $n -eq {on_call} ]; then echo "clean failed" >&2; exit 1; fi\n  fi\ndone\n'
                    f'exec {real} "$@"\n')
        os.chmod(wrapper, 0o755)
        self.addCleanup(lambda: os.path.exists(wrapper) and os.unlink(wrapper))

    def test_a_failed_clean_fails_the_step_before_anything_is_pushed(self):
        self.clean_fails(1)
        self.write("gate")
        r, out = self.pack_and_persist("gate")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("::error title=Persist::cannot fetch", r.stdout)
        self.assertFalse(self.origin_has("data/gate/new.json"))
        self.assertNotEqual(out.get("pushed"), "true")

    def test_a_failed_clean_after_a_rejected_push_fails_the_step(self):
        self.hook(reject=1)
        self.clean_fails(2)
        self.write("plan")
        r, out = self.pack_and_persist("plan")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("::error title=Persist::cannot re-fetch", r.stdout)
        self.assertFalse(self.origin_has("data/plan/new.json"))

    def test_no_early_exit_grep_in_a_pipeline(self):
        # Widened: -q in any short cluster, -q as its own token, --quiet, -m / --max-count.
        self.assertIsNotNone(early_exit_pipe_grep('git log | grep -qxF -- "$msg"'))
        self.assertIsNotNone(early_exit_pipe_grep('git log | grep -x -q -- "$msg"'))
        self.assertIsNotNone(early_exit_pipe_grep('git log | grep --quiet -xF -- "$msg"'))
        self.assertIsNotNone(early_exit_pipe_grep('git log | grep -m1 -xF -- "$msg"'))
        self.assertIsNotNone(early_exit_pipe_grep('git log | grep --max-count=1 -xF -- "$msg"'))
        self.assertIsNone(early_exit_pipe_grep('git log | grep -xF -- "$msg" >/dev/null'))
        self.assertIsNone(early_exit_pipe_grep(r"""printf '%s\n' "$names" | grep -x gate >/dev/null"""))
        # S16 (Probe): the forms that bypassed the fold-4 rule, and the safe forms that must stay allowed
        self.assertIsNotNone(early_exit_pipe_grep('if git log | grep -x -q -- "$msg"; then :; fi'))
        self.assertIsNotNone(early_exit_pipe_grep('if git log | grep --quiet -- "$msg"; then :; fi'))
        self.assertIsNotNone(early_exit_pipe_grep('if git log | grep -m1 -- "$msg" >/dev/null; then :; fi'))
        self.assertIsNotNone(early_exit_pipe_grep('if git log | grep -e "$msg" -q; then :; fi'))
        self.assertIsNotNone(early_exit_pipe_grep('if git log | head -1 | grep -xF -- "$msg" >/dev/null; then :; fi'))
        self.assertIsNotNone(early_exit_pipe_grep('git log | head -n 1 >/dev/null && echo landed'))
        self.assertIsNone(early_exit_pipe_grep('if [ -z "$(find "$d" -type f | head -n 1)" ]; then :; fi'))
        self.assertIsNone(early_exit_pipe_grep('x="$(ls a | head -1)"'))
        self.assertIsNone(early_exit_pipe_grep('var() { printf a | sed -n "s/^$1=//p" | head -n 1; }'))
        self.assertIsNone(early_exit_pipe_grep('git log | grep -e -q >/dev/null'))  # -q is the pattern here
        # S20 (Critic) / S16b (Probe): grep options anywhere before --, every early-exit flag, the grep variants and
        # wrappers, |&, and awk exit / sed q as pipe conditions
        for form in ('if ls | grep --silent x; then :; fi', 'if ls | grep x -q; then :; fi',
                     'if ls | grep -F x --quiet; then :; fi',
                     'if ls | egrep -q x; then :; fi', 'if ls | fgrep -q x; then :; fi',
                     'if ls | command grep -q x; then :; fi', 'if ls | /usr/bin/grep -q x; then :; fi',
                     'if ls | grep -l x >/dev/null; then :; fi', 'if ls | grep -L x >/dev/null; then :; fi',
                     'if ls | grep --files-with-matches x >/dev/null; then :; fi', 'if ls |& grep -q x; then :; fi',
                     'if ls | grep -m 1 x >/dev/null; then :; fi',
                     "if ls | awk '/x/{f=1; exit} END{exit !f}'; then :; fi", "ls | awk '/x/{exit}' && echo y",
                     "if ls | sed -n '/x/{p;q}' >/dev/null; then :; fi", "while ls | sed '/x/q' >/dev/null; do :; done",
                     "if ! ls | head -1 >/dev/null; then :; fi"):
            self.assertIsNotNone(early_exit_pipe_grep(form), form)
        # S23 (Critic): wrapper prefixes, a backslash / quoted / variable grep, sed Nq then a redirect, an assignment
        # from $( ) as the condition, and pipes or lists continued over lines; comments are not code
        hits = early_exit_hits
        for form in ('if ls | env grep -q x; then :; fi', 'if ls | env -u A LC_ALL=C grep -q x; then :; fi',
                     'if ls | LC_ALL=C grep -q x; then :; fi', 'if ls | timeout 5 grep -q x; then :; fi',
                     'if ls | timeout -k 2 -s KILL 5 grep -q x; then :; fi', 'if ls | nice -n 5 grep -q x; then :; fi',
                     'if ls | stdbuf -oL grep -q x; then :; fi', 'if ls | stdbuf -o L grep -q x; then :; fi',
                     'if ls | \\grep -q x; then :; fi', 'if ls | "grep" -q x; then :; fi',
                     "if ls | 'egrep' -q x; then :; fi", 'if ls | $GREP -q x; then :; fi',
                     'if ls | "${GREP}" -q x; then :; fi', 'if ls | env timeout 5 nice grep -q x; then :; fi',
                     'if ls | sed 5q >/dev/null; then :; fi', "if ls | sed '/x/q' >/dev/null; then :; fi",
                     'if first="$(ls | head -n 1)"; then :; fi', 'while ! v=$(ls | sed 1q); do :; done',
                     'if ls |\n    grep -q x; then :; fi', 'if ls |&\n    grep -q x; then :; fi',
                     'ls | head -n 1 >/dev/null &&\n  echo y', 'if ls \\\n  | grep -q x; then :; fi',
                     'if echo "a # b" | grep -q a; then :; fi', 'if [ $# -gt 0 ] && ls | grep -q x; then :; fi',
                     'v="${x#p}"; if ls | grep -q x; then :; fi',
                     'if ls | sed 1q; then :; fi', 'if ls | sed -e q; then :; fi', 'if ls | sed -n 1q >/dev/null; then :; fi',
                     'if ls | sed -e "s/a/b/;q"; then :; fi', 'if ls | { grep -q x; }; then :; fi',
                     'if ls | (grep -q x); then :; fi', 'if ls | ( grep -q x ); then :; fi', 'if ls | read -r v; then :; fi',
                     "if ls | perl -ne 'exit 0 if /x/'; then :; fi", "if ls | awk '{print \"x\"; exit}'; then :; fi"):
            self.assertTrue(hits(form), form)
        for form in ('# if ls | grep -q x; then', 'echo a  # | grep -q x', 'if ls | timeout 5 grep -x y >/dev/null; then :; fi',
                     'if LC_ALL=C printf a | grep -x a >/dev/null; then :; fi', 'first="$(ls | head -n 1)"',
                     "if ls | sed 's/x/q/' >/dev/null; then :; fi", "if ls | sed 's/x/q y/' >/dev/null; then :; fi",
                     'n="${#rc}"; echo "$# $n" | tr -d " "', 'echo "a # b" | grep -x a >/dev/null',
                     'if ls |\n    grep -x y >/dev/null; then :; fi', 'v="${x#pre}"; echo "$v" | cat',
                     'if ls | $SED -n p >/dev/null; then :; fi',
                     # S26 (Probe): text inside s/// and awk string literals is not a q or an exit
                     "if ls | sed -e 's/q;/x/' >/dev/null; then :; fi", "if ls | sed 's|q|x|g' >/dev/null; then :; fi",
                     "if ls | sed -n 's/a/q/p' >/dev/null; then :; fi", "if ls | awk '{print \"exit\"}'; then :; fi",
                     "if ls | perl -ne 'print \"exit\"'; then :; fi", 'if ls | grep -x "a q" >/dev/null; then :; fi'):
            self.assertFalse(hits(form), form)
        # S25-S27 (Critic @6a3c0261): grep inside a quoted or nested $( ), an escaped quote before a #, any
        # command of a { } / ( ) group the pipe feeds; awk -v values are data
        for form in ('if v="$(git log | grep -m1 x)"; then :; fi', 'if v="$(git log | grep -q x)"; then :; fi',
                     'if v="$(echo "$(git log | head -1)")"; then :; fi',
                     'if v="$(echo "$(git log | grep -q x)")"; then :; fi',
                     'echo "a\\" # " | grep -q x && echo y',
                     'if git log | { cat; grep -q x; }; then :; fi', 'if git log | ( read -r a; grep -q x ); then :; fi',
                     'if git log | { cat; head -n 1; } >/dev/null; then :; fi',
                     'if git log | { grep -x "}" >/dev/null; grep -q x; }; then :; fi',
                     'git log | { cat; (grep -q x); }',
                     'if git log | { cat; { grep -q x; }; }; then :; fi'):
            self.assertTrue(hits(form), form)
        # S27-S29 (Probe @6a3c0261): long-option prefixes, rg, sudo / busybox, bash -c, loop break, a later
        # assignment; one pinned form per wrapper (builtin, nohup, time, exec)
        for form in ('if ls | grep --qui x; then :; fi', 'if ls | grep --max=1 x >/dev/null; then :; fi',
                     'if ls | grep --files-with-match x; then :; fi', 'ls | grep --sil x && echo y',
                     'if ls | sudo grep -q x; then :; fi', 'if ls | sudo -u root grep -q x; then :; fi',
                     'if ls | busybox grep -q x; then :; fi', 'if ls | rg -q x; then :; fi',
                     'if ls | rg -g "*.md" -m1 x >/dev/null; then :; fi',
                     "bash -o pipefail -c 'git log | grep -q x'", 'sh -c "git log | grep -q \\"x\\""',
                     "bash -euo pipefail -c 'if git log | head -1 >/dev/null; then :; fi'",
                     'git log | while read -r l; do [ "$l" = x ] && break; done',
                     'if x=1 v="$(git log | head -1)"; then :; fi', 'if ls | grep -E -q x; then :; fi',
                     'sh -c "if v=\\"\\$(git log | head -1)\\"; then :; fi"',
                     'if ls | builtin read -r v; then :; fi', 'if ls | nohup grep -q x; then :; fi',
                     'if ls | time -p grep -q x; then :; fi', 'if ls | time grep -q x; then :; fi',
                     'if ls | exec grep -q x; then :; fi',
                     # S30 (Critic @0149c891): path-prefixed wrappers, and ggrep
                     'if ls | /usr/bin/sudo grep -q x; then :; fi',
                     'if ls | /usr/bin/sudo -u root grep -q x; then :; fi',
                     'if ls | /bin/busybox grep -q x; then :; fi',
                     'if ls | ggrep -q x; then :; fi', 'if ls | /usr/bin/ggrep -q x; then :; fi',
                     'if ls | /usr/bin/env grep -q x; then :; fi',
                     'if ls | /usr/bin/env LC_ALL=C grep -q x; then :; fi',
                     'if ls | /usr/bin/timeout 5 grep -q x; then :; fi',
                     # S30 (Probe @0149c891): more path-prefixed wrappers, and gegrep / gfgrep / bsdgrep
                     'if ls | /bin/sudo grep -q x; then :; fi',
                     'if ls | /usr/bin/busybox grep -q x; then :; fi',
                     'if ls | /usr/bin/nice grep -q x; then :; fi',
                     'if ls | /usr/bin/stdbuf -oL grep -q x; then :; fi',
                     'if ls | /usr/bin/nohup grep -q x; then :; fi',
                     'if ls | /usr/bin/time -p grep -q x; then :; fi',
                     'if ls | command -p /usr/bin/sudo grep -q x; then :; fi',
                     'if ls | gegrep -q x; then :; fi', 'if ls | gfgrep -q x; then :; fi',
                     'if ls | bsdgrep -q x; then :; fi', 'if ls | /usr/bin/gegrep -q x; then :; fi',
                     'if ls | /usr/bin/env /usr/bin/grep -q x; then :; fi',
                     'if ls | env /usr/bin/timeout 5 grep -q x; then :; fi'):
            self.assertTrue(hits(form), form)
        for form in ("if ls | awk '/exit/' >/dev/null; then :; fi", "if ls | awk '$1 ~ /exit/' >/dev/null; then :; fi",
                     "if ls | perl -ne 'print if /exit/' >/dev/null; then :; fi",
                     "if ls | awk '!/exit|q/ {print}' >/dev/null; then :; fi",
                     'if ls | grep --fi=p x >/dev/null; then :; fi', 'if ls | grep --line x >/dev/null; then :; fi',
                     'if ls | rg -E utf8 x >/dev/null; then :; fi', 'if ls | rg -g -q x >/dev/null; then :; fi', 'git log | while read -r l; do echo "$l"; done',
                     'for x in a b; do ls | grep -x "$x" >/dev/null || break; done',
                     "bash -c 'git log | grep -x a >/dev/null'", 'if x=1 v="$(git log | grep -c a)"; then :; fi',
                     'if ls | /usr/bin/sudoedit grep -q x; then :; fi'):
            self.assertFalse(hits(form), form)
        for form in ("if ls | awk '/x/ {exit}'; then :; fi", "if ls | perl -ne 'exit if /x/'; then :; fi",
                     "if ls | awk '$1 ~ /x/ {exit}'; then :; fi"):
            self.assertTrue(hits(form), form)
        for form in ("if ls | awk -v e=exit '{print e}' >/dev/null; then :; fi",
                     "if ls | awk --assign=e=exit '{print e}' >/dev/null; then :; fi",
                     'if [ -n "$(git log | grep x)" ]; then :; fi', 'if v="$(git log | grep -c x)"; then :; fi',
                     'if git log | { cat; } >/dev/null; then :; fi', 'echo "a\\"b" | grep -x a >/dev/null || true',
                     r'echo a\#b | grep -x a >/dev/null', r'echo a\" # | grep -q x', r"echo 'a\' # | grep -q x", 'echo "a\\" # | grep -q x"', 'x=1 # \\"; ls | grep -q x'):
            self.assertFalse(hits(form), form)
        synthetic = {"jobs": {
            "a": {"steps": [{"name": "custom", "shell": "bash --noprofile --norc -eo pipefail {0}", "run": "x"},
                            {"name": "plain-e", "shell": "bash -e {0}", "run": "x"},
                            {"name": "default", "run": "x"}, {"name": "inline", "run": "set -o pipefail; x"}]},
            "b": {"defaults": {"run": {"shell": "bash"}}, "steps": [{"name": "job-default", "run": "x"}]}}}
        self.assertEqual([st["name"] for _, _, st in pipefail_steps(synthetic)], ["custom", "inline", "job-default"])
        for form in ('if ls | grep -c x >/dev/null; then :; fi', 'if ls | grep -x -- -q >/dev/null; then :; fi',
                     'if ls || grep -q x f; then :; fi', "x=\"$(ls | awk '{print; exit}')\"",
                     "if ls | sed 's/q/x/' >/dev/null; then :; fi", "ls | awk '{print}' | tail -n 1",
                     'if ls | grep -e -l -F >/dev/null; then :; fi'):
            self.assertIsNone(early_exit_pipe_grep(form), form)
        # Scope: lanes and keyless in full, and every pipefail step of ci.yml (explicit shell: bash, or a pipefail
        # in the run). ci.yml's default-shell steps run bash -e with no pipefail, so a SIGPIPE cannot turn a
        # condition false there (the preexisting `git ls-files | grep -Pq` in lint is one).
        self.assertEqual([os.path.basename(p) for p in GUARDED_WORKFLOWS],
                         ["mythos-engine-lanes.yml", "mythos-engine-keyless.yml"])
        self.assertEqual([os.path.basename(p) for p in PIPEFAIL_SCOPED_WORKFLOWS], ["ci.yml"])
        with open(CI, encoding="utf-8") as f:
            ci_doc = yaml.safe_load(f)
        docs = {LANES: LANES_DOC, KEYLESS: KEYLESS_DOC, CI: ci_doc}
        scanned = [(p, list(all_steps(docs[p]))) for p in GUARDED_WORKFLOWS]
        scanned += [(p, list(pipefail_steps(docs[p]))) for p in PIPEFAIL_SCOPED_WORKFLOWS]
        self.assertGreater(len(scanned[-1][1]), 10, "ci.yml's pipefail steps (build-windows, notes-windows) scanned")
        for path, steps in scanned:
            for name, _, st in steps:
                found = early_exit_hits(str(st.get("run") or ""))
                self.assertEqual(found, [], (os.path.basename(path), name, st.get("name")))

    def test_a_git_log_failure_in_the_landed_check_fails_loud(self):
        # A git log failure must not read as "not landed": that would re-apply and (with one
        # rejection already used) push on the next try. Fail the step with an explicit error.
        self.hook(reject=1)
        real = shutil.which("git")
        wrapper = os.path.join(self.box.bin, "git")
        with open(wrapper, "w") as f:
            f.write(f'#!/bin/bash\nfor a in "$@"; do\n'
                    f'  if [ "$a" = log ]; then echo "fatal: bad FETCH_HEAD" >&2; exit 128; fi\n'
                    f'done\nexec {real} "$@"\n')
        os.chmod(wrapper, 0o755)
        self.addCleanup(lambda: os.path.exists(wrapper) and os.unlink(wrapper))
        self.write("fix")
        r, out = self.pack_and_persist("fix")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("::error title=Persist::cannot read landed-push subjects", r.stdout)
        self.assertIn("before re-running", r.stdout)  # S21: tells the operator to check the state branch first
        self.assertNotIn("fatal: bad FETCH_HEAD", r.stdout + r.stderr)  # git log's stderr stays private
        self.assertIn("fatal: bad FETCH_HEAD", self.box.logs_text())
        self.assertFalse(self.origin_has("data/fix/new.json"))
        self.assertNotEqual(out.get("pushed"), "true")

    def test_a_lied_push_then_a_git_log_failure_is_red_and_not_applied_twice(self):
        # HARD-H (Probe's S17 repro): the push lands but reports failure, then the landed check's git log fails. That
        # must not read as "not landed" (re-apply onto the newest state, a second commit, a doubled append row, green).
        # Every job's persist copy is run, so a revert in any one of the four is caught by behaviour, not only text.
        real = shutil.which("git")
        wrapper = os.path.join(self.box.bin, "git")
        self.addCleanup(lambda: os.path.exists(wrapper) and os.unlink(wrapper))
        for job in STATE_JOBS:
            with self.subTest(job=job):
                flag = os.path.join(self.box.root, f"push-lied-{job}")
                with open(wrapper, "w") as f:
                    f.write(f'#!/bin/sh\nfor a in "$@"; do\n'
                            f'  if [ "$a" = push ] && [ ! -e {flag} ]; then\n'
                            f'    : > {flag}; {real} "$@"; echo "timed out" >&2; exit 1\n  fi\n'
                            f'  if [ "$a" = log ] && [ -e {flag} ]; then echo "fatal: bad object FETCH_HEAD" >&2; exit 128; fi\n'
                            f'done\nexec {real} "$@"\n')
                os.chmod(wrapper, 0o755)
                self.write(job, "rows.jsonl", '{"a": 1}\n')  # an append row: a re-apply would double it
                r, out = self.pack_and_persist(job)
                os.unlink(wrapper)
                self.assertTrue(os.path.exists(flag))
                self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn("::error title=Persist::cannot read landed-push subjects", r.stdout)
                self.assertIn(f'the push may have landed: check engine-state for "engine: {job} state '
                              f'(https://example.invalid/run/1)" before re-running', r.stdout)
                self.assertNotIn("bad object FETCH_HEAD", r.stdout + r.stderr)
                self.assertNotEqual(out.get("pushed"), "true")
                msgs = subprocess.run(["git", "--git-dir", self.bare, "log", "--format=%s", "engine-state"],
                                      capture_output=True, text=True, env=self.box.env({})).stdout.splitlines()
                self.assertEqual(msgs.count(f"engine: {job} state (https://example.invalid/run/1)"), 1, msgs)
                self.assertEqual(self.origin_text(f"data/{job}/rows.jsonl"), '{"a": 1}\n')
                # the next job starts from the newest state, as a real run would
                self.box.git("fetch", "-q", "origin", "engine-state", cwd=self.state)
                self.box.git("reset", "-q", "--hard", "FETCH_HEAD", cwd=self.state)

    def test_a_push_that_landed_but_reported_failure_is_not_applied_twice(self):
        real = shutil.which("git")
        flag = os.path.join(self.box.root, "push-lied")
        wrapper = os.path.join(self.box.bin, "git")
        with open(wrapper, "w") as f:
            f.write(f'#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = push ] && [ ! -e {flag} ]; then\n'
                    f'    : > {flag}; {real} "$@"; echo "timed out" >&2; exit 1\n  fi\ndone\nexec {real} "$@"\n')
        os.chmod(wrapper, 0o755)
        self.write("fix")
        r, out = self.pack_and_persist("fix")
        os.unlink(wrapper)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(flag))
        self.assertEqual(out.get("pushed"), "true")
        msgs = subprocess.run(["git", "--git-dir", self.bare, "log", "--format=%s", "engine-state"],
                              capture_output=True, text=True, env=self.box.env({})).stdout.splitlines()
        self.assertEqual(msgs.count("engine: fix state (https://example.invalid/run/1)"), 1)

    def test_five_rejections_fail_loud(self):
        self.hook(reject=99)
        self.write("plan")
        r, out = self.pack_and_persist("plan")
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error title=Persist::push to engine-state failed 5 times", r.stdout)
        self.assertNotEqual(out.get("pushed"), "true")

    def test_conflict_rc3_still_pushes_then_fails(self):
        self.write("gate")
        r, out = self.pack_and_persist("gate", {"FAKE_APPLY_RC": "3"})
        self.assertEqual(r.returncode, 3)
        self.assertEqual(out.get("pushed"), "true")
        self.assertTrue(self.origin_has("data/gate/new.json"))

    def test_refused_apply_stops(self):
        self.write("fix")
        r, out = self.pack_and_persist("fix", {"FAKE_APPLY_RC": "2"})
        self.assertEqual(r.returncode, 2)
        self.assertNotEqual(out.get("pushed"), "true")

    def test_nothing_new_is_pushed_false(self):
        # the same bytes are already on engine-state: nothing to commit, green, pushed=false
        self.write("tick")
        self.box.git("add", "-A", cwd=self.state)
        self.box.git("commit", "-q", "-m", "already", cwd=self.state)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.state)
        base = self.box.git("rev-parse", "HEAD~1", cwd=self.state).stdout.strip()
        job_env = LANES_DOC["jobs"]["gate"]["env"]
        self.write("gate")
        r = self.box.run_step(step(LANES_DOC, "gate", "pack"), {"BASE": base}, job_env)
        self.assertEqual(r.returncode, 0)
        subprocess.run(["git", "-C", self.state, "push", "-q", "origin", "HEAD:engine-state"], env=self.box.env({}))
        self.box.git("add", "-A", cwd=self.state)
        self.box.git("commit", "-q", "-m", "gate already", cwd=self.state)
        self.box.git("push", "-q", "origin", "HEAD:engine-state", cwd=self.state)
        open(self.box.out, "w").close()
        r = self.box.run_step(step(LANES_DOC, "gate", "persist"),
                              {"STATE_BRANCH": "engine-state", "RUN_URL": "u", "MYTHOS_DATA_ROOT": self.state,
                               "DATA_TOKEN": "t"}, job_env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.box.outputs().get("pushed"), "false")

    def test_token_never_lands_in_git_config(self):
        self.write("gate")
        r, _ = self.pack_and_persist("gate")
        self.assertEqual(r.returncode, 0)
        for d, _, fs in os.walk(os.path.join(self.state, ".git")):
            for f in fs:
                if f in ("config", "FETCH_HEAD") or d.endswith(".git"):
                    with open(os.path.join(d, f), "rb") as fh:
                        self.assertNotIn(b"tok-SENTINEL", fh.read(), os.path.join(d, f))


# ================================================================ behaviour: private log + redaction (F2)
class PrivateLogBehaviour(Sandboxed):
    def setUp(self):
        super().setUp()
        self.bare = self.box.remote("ops", OPS)

    def privlog(self, job, doc=LANES_DOC, token="t", key="5-1"):
        st = step(doc, job, "privlog")
        env = {"DATA_TOKEN": token, "RUN_KEY": key, "DATA_REPO": OPS, "LOG_BRANCH": "lanes-logs"}
        return self.box.run_step(st, env)

    def logged(self, rel):
        """rel is runs/<key>/<job>/<file>; the branch keeps it under runs/<YYYY-MM-DD>/<key>/<job>/<file>.
        The day dir is matched by shape, not recomputed here, so a run across local midnight cannot flake (S15)."""
        r = subprocess.run(["git", "--git-dir", self.bare, "ls-tree", "-r", "--name-only", "lanes-logs"],
                           capture_output=True, text=True, env=self.box.env({}))
        if r.returncode != 0:
            return None
        want = re.compile(r"runs/\d{4}-\d{2}-\d{2}/" + re.escape(rel[len("runs/"):]))
        hits = [p for p in r.stdout.splitlines() if want.fullmatch(p)]
        if not hits:
            return None
        self.assertEqual(len(hits), 1, hits)
        r = subprocess.run(["git", "--git-dir", self.bare, "show", f"lanes-logs:{hits[0]}"], capture_output=True,
                           text=True, env=self.box.env({}))
        return r.stdout if r.returncode == 0 else None

    def test_every_private_log_is_keyed_by_run_and_attempt(self):
        # a re-run attempt must never overwrite attempt 1's logs (HARD-G)
        n = 0
        for doc in (LANES_DOC, KEYLESS_DOC):
            for name, _, st in all_steps(doc):
                if st.get("id") == "privlog":
                    n += 1
                    self.assertEqual(st["env"]["RUN_KEY"], "${{ github.run_id }}-${{ github.run_attempt }}", name)
                    self.assertIn('dest="runs/$(TZ=America/Denver date +%F)/$RUN_KEY/$JOB"', st["run"], name)
        self.assertEqual(n, 7)

    def test_a_second_attempt_keeps_the_first_attempts_logs(self):
        with open(os.path.join(self.box.log, "scan.log"), "w") as f:
            f.write("attempt one\n")
        self.assertEqual(self.privlog("tick", key="5-1").returncode, 0)
        with open(os.path.join(self.box.log, "scan.log"), "w") as f:
            f.write("attempt two\n")
        self.assertEqual(self.privlog("tick", key="5-2").returncode, 0)
        self.assertEqual(self.logged("runs/5-1/tick/scan.log"), "attempt one\n")
        self.assertEqual(self.logged("runs/5-2/tick/scan.log"), "attempt two\n")

    def test_empty_logs_commit_nothing(self):
        open(os.path.join(self.box.log, "mode.log"), "w").close()
        r = self.privlog("tick")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("private log: nothing to save", r.stdout)
        r = subprocess.run(["git", "--git-dir", self.bare, "rev-parse", "--verify", "-q", "lanes-logs"],
                           capture_output=True, env=self.box.env({}))
        self.assertNotEqual(r.returncode, 0)

    def test_empty_logs_are_left_out_and_retries_back_off(self):
        open(os.path.join(self.box.log, "mode.log"), "w").close()
        with open(os.path.join(self.box.log, "scan.log"), "w") as f:
            f.write("x\n")
        h = os.path.join(self.bare, "hooks", "pre-receive")
        cnt = os.path.join(self.box.root, "log-push-count")
        with open(h, "w") as f:
            f.write(f"#!/bin/sh\nn=$(cat {cnt} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {cnt}\n[ $n -gt 2 ] || exit 1\n")
        os.chmod(h, 0o755)
        r = self.privlog("plan")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.logged("runs/5-1/plan/scan.log"), "x\n")
        self.assertIsNone(self.logged("runs/5-1/plan/mode.log"))
        self.assertEqual(len(open(self.box.sleeps).read().split()), 2)

    def test_full_output_goes_private_and_public_gets_titles_only(self):
        with open(os.path.join(self.box.log, "scan.log"), "w") as f:
            f.write("PRIVATE-LINE crew/probe/v1-abcdef12-gate.md\n::error title=Claude login failed::PRIVATE-BODY\n"
                    "::warning title=bad $(id) `x`::PRIVATE-2\n")
        r = self.privlog("tick")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("::error title=Claude login failed::details are in the private log", r.stdout)
        self.assertNotIn("PRIVATE", r.stdout + r.stderr)
        self.assertNotIn("$(id)", r.stdout)
        self.assertIn("PRIVATE-LINE", self.logged("runs/5-1/tick/scan.log"))
        with open(os.path.join(self.box.log, "scan.log"), "w") as f:
            f.write("second job\n")
        r = self.privlog("gate", key="5-1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("PRIVATE-LINE", self.logged("runs/5-1/tick/scan.log"))
        self.assertEqual(self.logged("runs/5-1/gate/scan.log"), "second job\n")

    def test_missing_token_fails_loud(self):
        with open(os.path.join(self.box.log, "a.log"), "w") as f:
            f.write("x\n")
        r = self.privlog("act", token="")
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error title=Private log::MYTHOS_DATA_TOKEN is not set", r.stdout)

    def test_large_logs_keep_the_tail(self):
        with open(os.path.join(self.box.log, "gate-pass.log"), "w") as f:
            f.write("HEAD-LINE\n" + "x" * (6 * 1024 * 1024) + "\nTAIL-LINE\n")
        r = self.privlog("gate")
        self.assertEqual(r.returncode, 0, r.stderr)
        got = self.logged("runs/5-1/gate/gate-pass.log")
        self.assertEqual(len(got.encode()), 5 * 1024 * 1024)
        self.assertTrue(got.endswith("TAIL-LINE\n"))

    def test_keyless_saves_its_suite_log(self):
        with open(os.path.join(self.box.log, "suite.log"), "w") as f:
            f.write("test_secret_name ... ok\n")
        r = self.privlog("tests", doc=KEYLESS_DOC)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("test_secret_name", self.logged("runs/5-1/keyless/suite.log"))


class RedactionBehaviour(Sandboxed):
    """The named steps run against fake scripts that print private text: none reaches the public log."""

    def setUp(self):
        super().setUp()
        st = os.path.join(self.box.root, "state")
        self.box.git("init", "-q", st)
        self.box.git("commit", "-q", "--allow-empty", "-m", "s", cwd=st)

    def check(self, job, key, extra=None, doc=LANES_DOC, rc=0, stdout_logged=True):
        env = {"MYTHOS_DATA_ROOT": os.path.join(self.box.root, "state"), "JOB_T0": str(int(time.time())),
               "MODE": "pass", "PR": "", "HAS_WRITE_TOKEN": "true", "FIX_ON": "on", "BASE": "HEAD",
               "GATE_APP_ID": "1", "INSTALLATION_ID": "2"}
        env.update(extra or {})
        open(self.box.out, "w").close()
        r = self.box.run_step(step(doc, job, key), env, doc["jobs"][job].get("env"))
        self.assertEqual(r.returncode, rc, (job, key, r.stdout, r.stderr))
        self.assertNotIn("PRIVATE", r.stdout + r.stderr, (job, key))
        if stdout_logged:  # a count step keeps stdout (one number) and logs stderr
            self.assertIn("PRIVATE-STDOUT", self.box.logs_text(), (job, key))
        self.assertIn("PRIVATE-STDERR", self.box.logs_text(), (job, key))
        return r, self.box.outputs()

    def test_scan(self):
        r, out = self.check("tick", "scan", {"FAKE_LINES": "#12 abc: candidate|#13 def: waiting (ci)"})
        self.assertEqual(out.get("work"), "true")
        self.assertIn("scan: 1 candidate(s), 1 waiting", r.stdout)

    def test_plan_scan(self):
        r, out = self.check("tick", "plan", {"FAKE_LINES": "work=2"})
        self.assertEqual(out.get("plan"), "true")

    def test_act_scan(self):
        r, out = self.check("tick", "act", {"FAKE_LINES": "3|#5: ready to arm"})
        self.assertEqual(out.get("act"), "true")

    def test_brother_seen_list_reason_stays_private(self):
        r, _ = self.check("tick", "Brother seen list")
        self.assertIn("refresh: no", r.stdout)

    def test_fix_scan_and_flow_and_publish(self):
        self.check("tick", "fix", stdout_logged=False)
        self.check("tick", "Flow step")
        self.check("tick", "Publish mythos/final-gate")
        self.check("publish", "Publish mythos/final-gate")

    def test_final_gate_pass(self):
        r, out = self.check("gate", "pass")
        self.assertEqual(out.get("rc"), "0")
        r, out = self.check("gate", "pass", {"FAKE_RC": "4"})
        self.assertEqual(out.get("rc"), "4")

    def test_plan_pass_fix_round_and_push(self):
        self.check("plan", "pass")
        self.check("fix", "round")
        os.makedirs(os.path.join(self.box.tmp, "fix-stage"))
        open(os.path.join(self.box.tmp, "fix-stage", "round.json"), "w").close()
        self.check("fix", "push")

    def test_act_steps(self):
        self.check("act", "proof")
        self.check("act", "Arm auto-merge")

    def test_keyless_suite_output_private_and_failure_loud(self):
        code = os.path.join(self.box.root, "code")
        st = step(KEYLESS_DOC, "tests", "Run the engine test suite")
        r = self.box.run_step(st)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("PRIVATE", r.stdout + r.stderr)
        self.assertIn("PRIVATE-STDOUT", self.box.logs_text())
        r = self.box.run_step(st, {"FAKE_RC": "1"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("engine suite: exit 1", r.stdout)
        self.assertTrue(os.path.isdir(code))

    def test_keyless_missing_secret_fails_loud(self):
        st = step(KEYLESS_DOC, "tests", "Secrets present")
        for read, data in (("false", "true"), ("true", "false")):
            r = self.box.run_step(st, {"HAS_READ": read, "HAS_DATA": data})
            self.assertEqual(r.returncode, 1)
            self.assertIn("::error title=Keyless secrets::", r.stdout)
        r = self.box.run_step(st, {"HAS_READ": "true", "HAS_DATA": "true"})
        self.assertEqual(r.returncode, 0)


class ThisFile(unittest.TestCase):
    def test_this_file_compiles_with_no_syntax_warnings(self):
        # S29 (Critic / Probe @0149c891): py_compile this file with warnings as errors
        with tempfile.TemporaryDirectory() as td:
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                py_compile.compile(__file__, cfile=os.path.join(td, "t.pyc"), doraise=True)


if __name__ == "__main__":
    unittest.main()
